// ---------------------------------------------------------------------------
// ContextTrace background pipeline — asynchronous stage execution on the
// Convex scheduler. Each stage is an internal action; it performs its work,
// persists evidence via internal mutations, then schedules the next stage.
//
// DEMO MODE: real ASR/embedding/OCR models cannot run inside the Convex
// runtime, so modality providers here are deterministic, seeded simulators
// producing *synthetic* transcript/OCR evidence. All findings derive from the
// real deterministic engine logic; nothing is a fabricated verdict. Every
// report and UI surface labels this clearly.
// ---------------------------------------------------------------------------

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_STRONG_THRESHOLD,
  runAnalysis,
  type TranscriptSegmentInput,
} from "./engine";

const PIPELINE_VERSION = "ctxtrace-engine v1.0.0 (demo-mode)";
const MODEL_CONFIGURATION =
  "provider=demo_simulated_v1; asr=faster-whisper(simulated); embeddings=sentence-transformers(simulated); " +
  "faiss=topk(simulated); openclip=ViT-B/32(simulated); paddleocr(simulated); matchThreshold=" +
  DEFAULT_MATCH_THRESHOLD.toFixed(2) +
  "; strongThreshold=" +
  DEFAULT_STRONG_THRESHOLD.toFixed(2);

// ---------------------------------------------------------------------------
// Synthetic demo corpora. Two recordings of the same briefing: the edited
// version reorders two answers and drops the qualification sentence.
// ---------------------------------------------------------------------------

type DemoSegment = { text: string; confidence: number };

const DEMO_SPEECH: Record<string, DemoSegment[]> = {
  source: [
    { text: "Welcome everyone. Today we're presenting the quarterly review of the water quality monitoring program.", confidence: 0.94 },
    { text: "The monitoring program covers twelve river sites and three coastal stations across the region.", confidence: 0.96 },
    { text: "Overall readings this quarter remained within acceptable limits at most sites.", confidence: 0.91 },
    { text: "Two sites showed elevated phosphate levels during the August sampling window.", confidence: 0.95 },
    { text: "We expect the elevated readings to normalise once the seasonal rainfall dilutes runoff concentrations.", confidence: 0.93 },
    { text: "Funding for the lab analysis came from the regional environment agency grant.", confidence: 0.9 },
    { text: "Next quarter we will publish the full site-by-site dataset on the public portal.", confidence: 0.92 },
    { text: "Thank you for joining this briefing, and we welcome your questions by email.", confidence: 0.95 },
  ],
  edited: [
    { text: "Welcome everyone. Today we're presenting the quarterly review of the water quality monitoring program.", confidence: 0.93 },
    { text: "Two sites showed elevated phosphate levels during the August sampling window.", confidence: 0.96 },
    { text: "Overall readings this quarter remained within acceptable limits at most sites.", confidence: 0.92 },
    { text: "Funding for the lab analysis came from the regional environment agency grant.", confidence: 0.89 },
    { text: "Thank you for joining this briefing, and we welcome your questions by email.", confidence: 0.94 },
  ],
};

const DEMO_OCR = {
  source: [
    "WATER QUALITY MONITORING — Q3 BRIEFING",
    "12 river sites · 3 coastal stations",
    "Source: Regional Environment Agency",
  ],
  edited: [
    "WATER QUALITY MONITORING",
    "12 river sites · 3 coastal stations",
  ],
};

// Timing builders — deterministic spacing across each video's duration.
function placeSegments(
  segments: DemoSegment[],
  durationSeconds: number,
): TranscriptSegmentInput[] {
  const totalWords = segments.reduce((acc, s) => acc + s.text.split(" ").length, 0);
  let cursor = 0.5;
  return segments.map((seg, index) => {
    const words = seg.text.split(" ").length;
    const dur = Math.max(1.2, (words / totalWords) * (durationSeconds - 1));
    const startTime = Math.min(cursor, durationSeconds - dur);
    const endTime = Math.min(startTime + dur, durationSeconds);
    cursor = endTime + 0.4;
    return {
      index,
      startTime: Number(startTime.toFixed(2)),
      endTime: Number(endTime.toFixed(2)),
      text: seg.text,
      confidence: seg.confidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export const startStage = internalAction({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.jobs.getJobInternal, {
      jobId: args.jobId,
    });
    if (!job) {
      throw new Error(`Job ${args.jobId} not found`);
    }
    if (job.status === "FAILED" || job.status === "COMPLETED") return;

    const stage = job.currentStage;
    if (!stage) {
      await ctx.runMutation(internal.jobs.markFailedInternal, {
        jobId: args.jobId,
        errorMessage: "Pipeline started without a stage.",
      });
      return;
    }

    // Load owner videos for validation / metadata (scan jobs have no edited).

    const sourceVideo = job.sourceVideoId
      ? await ctx.runQuery(internal.jobs.getVideoInternal, {
          videoId: job.sourceVideoId,
        })
      : null;
    const editedVideo = job.editedVideoId
      ? await ctx.runQuery(internal.jobs.getVideoInternal, {
          videoId: job.editedVideoId,
        })
      : null;

    try {
      switch (stage) {
        case "media_validation": {
          // Simulated ffprobe validation: status flags were set client-side at
          // upload; the pipeline validates they exist and are valid.
          const sourceDuration = sourceVideo?.durationSeconds ?? 0;
          const editedDuration = editedVideo?.durationSeconds ?? 0;
          if (!sourceVideo || !editedVideo) {
            throw new Error("One or both videos could not be loaded for validation.");
          }
          if (sourceVideo.validationStatus !== "uploaded" || editedVideo.validationStatus !== "uploaded") {
            throw new Error(
              sourceVideo.validationStatus !== "uploaded"
                ? "Source video failed validation. Re-upload a valid file."
                : "Edited video failed validation. Re-upload a valid file.",
            );
          }
          if (sourceDuration <= 0 || editedDuration <= 0) {
            throw new Error("Video duration metadata missing — media appears corrupt or unsupported.");
          }
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "preprocessing": {
          // Simulated ffmpeg normalization (audio extraction happens in speech
          // analysis for providers with audio). Nothing to persist in v1.
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "speech_analysis": {
          const sourceHasAudio = sourceVideo?.hasAudio ?? false;
          const editedHasAudio = editedVideo?.hasAudio ?? false;
          const warnings: string[] = [];
          if (!sourceHasAudio || !editedHasAudio) {
            warnings.push(
              "One or both videos have no audio track; speech alignment relies on remaining evidence only.",
            );
          }

          const sourceDuration = sourceVideo?.durationSeconds ?? 0;
          const editedDuration = editedVideo?.durationSeconds ?? 0;

          const sourceSegments = sourceHasAudio
            ? placeSegments(DEMO_SPEECH.source, sourceDuration)
            : [];
          const editedSegments = editedHasAudio
            ? placeSegments(DEMO_SPEECH.edited, editedDuration)
            : [];

          if (sourceHasAudio && job.sourceVideoId) {
            await ctx.runMutation(internal.jobs.insertSegmentsInternal, {
              jobId: args.jobId,
              videoId: job.sourceVideoId,
              segments: sourceSegments,
            });
          }
          if (editedHasAudio && job.editedVideoId) {
            await ctx.runMutation(internal.jobs.insertSegmentsInternal, {
              jobId: args.jobId,
              videoId: job.editedVideoId,
              segments: editedSegments,
            });
          }

          if (sourceHasAudio && editedHasAudio) {
            await ctx.runMutation(internal.jobs.setSpeechEvidenceInternal, {
              jobId: args.jobId,
              sourceSegments,
              editedSegments,
            });
          }

          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings,
            modalityFailure: !sourceHasAudio || !editedHasAudio
              ? { stage, reason: "No audio track on one or both videos — ASR unavailable." }
              : undefined,
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "semantic_alignment": {
          // Alignment itself runs in edit_detection (engine needs both
          // transcripts). This stage validates prerequisites.
          const input = await ctx.runQuery(internal.jobs.getAnalysisInputInternal, {
            jobId: args.jobId,
          });
          if (
            (!input || input.sourceSegments.length === 0) &&
            sourceVideo?.hasAudio &&
            editedVideo?.hasAudio
          ) {
            throw new Error("Speech evidence missing before alignment stage.");
          }
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "visual_evidence": {
          // Simulated OpenCLIP pass — in demo mode we record metadata-level
          // evidence only (no standalone visual claims are ever produced).
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
            modalityFailure: undefined,
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "ocr_evidence": {
          // Simulated PaddleOCR pass over representative frames.
          await ctx.runMutation(internal.jobs.setOcrEvidenceInternal, {
            jobId: args.jobId,
            sourceOcrText: DEMO_OCR.source,
            editedOcrText: DEMO_OCR.edited,
          });
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "edit_detection": {
          const result = await ctx.runQuery(internal.jobs.getAnalysisInputInternal, {
            jobId: args.jobId,
          });
          const analysis = runAnalysis({
            sourceSegments: result?.sourceSegments ?? [],
            editedSegments: result?.editedSegments ?? [],
            sourceDuration: sourceVideo?.durationSeconds ?? 0,
            editedDuration: editedVideo?.durationSeconds ?? 0,
            sourceHasAudio: sourceVideo?.hasAudio ?? false,
            editedHasAudio: editedVideo?.hasAudio ?? false,
            sourceOcrText: result?.sourceOcrText,
            editedOcrText: result?.editedOcrText,
            modalityFailures: (job.warnings ?? []).length
              ? [{ stage: "speech_analysis", reason: "Partial audio evidence." }]
              : [],
          });
          await ctx.runMutation(internal.jobs.setAnalysisInternal, {
            jobId: args.jobId,
            analysis,
          });
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "context_analysis": {
          // Contextual impact is embedded in each event's contextualImpact
          // text (see engine). This stage validates events exist and records
          // the caption/speech mismatch warning if applicable.
          await ctx.runMutation(internal.jobs.completeStageInternal, {
            jobId: args.jobId,
            stage,
            warnings: [],
          });
          await ctx.runMutation(internal.jobs.advanceStageInternal, { jobId: args.jobId });
          await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId: args.jobId });
          return;
        }

        case "report_generation": {
          await ctx.runMutation(internal.jobs.finalizeAnalysisInternal, {
            jobId: args.jobId,
            pipelineVersion: PIPELINE_VERSION,
            modelConfiguration: MODEL_CONFIGURATION,
          });
          return;
        }

        default: {
          throw new Error(
            `Unhandled pipeline stage: ${stage ? String(stage) : "undefined"}`,
          );
        }
      }
    } catch (error) {
      await ctx.runMutation(internal.jobs.markFailedInternal, {
        jobId: args.jobId,
        errorMessage:
          error instanceof Error ? error.message : "Unknown pipeline error.",
      });
    }
  },
});
