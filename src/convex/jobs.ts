import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  action,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal, api } from "./_generated/api";
import { PIPELINE_STAGES } from "./schema";
import type { AnalysisResult, TranscriptSegmentInput } from "./engine";
import { checkCaptionMismatch, formatTimestamp } from "./engine";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a job from two uploaded videos, validate ownership, start pipeline. */
export const createJob = action({
  args: {
    sourceVideoId: v.id("videos"),
    editedVideoId: v.id("videos"),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");

    const source = await ctx.runQuery(api.videos.getOwned, {
      videoId: args.sourceVideoId,
    });
    const edited = await ctx.runQuery(api.videos.getOwned, {
      videoId: args.editedVideoId,
    });
    if (!source || !edited) {
      throw new Error("Videos not found or not owned by you.");
    }
    if (
      source.validationStatus !== "uploaded" ||
      edited.validationStatus !== "uploaded"
    ) {
      throw new Error("Both videos must pass validation before analysis.");
    }

    const jobId = await ctx.runMutation(internal.jobs.createJobInternal, {
      ownerId: userId,
      sourceVideoId: args.sourceVideoId,
      editedVideoId: args.editedVideoId,
    });

    await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId });
    return jobId;
  },
});

// ---------------------------------------------------------------------------
// Job queries (public, ownership-checked)
// ---------------------------------------------------------------------------

/** Job with joined video records — used by progress + report pages. */
export const getJob = query({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) return null;

    const sourceVideo = await ctx.db.get(job.sourceVideoId);
    const editedVideo = await ctx.db.get(job.editedVideoId);

    const videoShape = (vid: typeof sourceVideo) =>
      vid
        ? {
            _id: vid._id,
            filename: vid.filename,
            durationSeconds: vid.durationSeconds,
            hasAudio: vid.hasAudio,
            byteSize: vid.byteSize,
            mimeType: vid.mimeType,
            storageKey: vid.storageKey,
          }
        : null;

    return {
      _id: job._id,
      status: job.status,
      currentStage: job.currentStage,
      progress: job.progress,
      warnings: job.warnings ?? [],
      errorMessage: job.errorMessage,
      pipelineVersion: job.pipelineVersion,
      modelConfiguration: job.modelConfiguration,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      sourceVideo: videoShape(sourceVideo),
      editedVideo: videoShape(editedVideo),
    };
  },
});

/** All jobs for the current user (history page + dashboard). */
export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const jobs = await ctx.db
      .query("analysisJobs")
      .withIndex("by_owner_created", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(100);

    return await Promise.all(
      jobs.map(async (job) => {
        const report =
          job.status === "COMPLETED" || job.status === "DEGRADED"
            ? await ctx.db
                .query("reports")
                .withIndex("by_job", (q) => q.eq("jobId", job._id))
                .first()
            : null;
        const sourceVideo = await ctx.db.get(job.sourceVideoId);
        const editedVideo = await ctx.db.get(job.editedVideoId);
        return {
          _id: job._id,
          status: job.status,
          currentStage: job.currentStage,
          progress: job.progress,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          errorMessage: job.errorMessage,
          warnings: job.warnings ?? [],
          sourceFilename: sourceVideo?.filename ?? "—",
          editedFilename: editedVideo?.filename ?? "—",
          sourceVideoKey: sourceVideo?.storageKey ?? null,
          editedVideoKey: editedVideo?.storageKey ?? null,
          report: report
            ? {
                score: report.score,
                overallConfidence: report.overallConfidence,
                degraded: report.degraded,
              }
            : null,
        };
      }),
    );
  },
});

/** Report for a job (owner only). */
export const getReport = query({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) return null;
    const report = await ctx.db
      .query("reports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!report) return null;
    return {
      _id: report._id,
      jobId: report.jobId,
      score: report.score,
      overallConfidence: report.overallConfidence,
      evidenceCoverage: report.evidenceCoverage,
      uncertainty: report.uncertainty,
      interpretation: report.interpretation,
      pipelineVersion: report.pipelineVersion,
      modelConfiguration: report.modelConfiguration,
      degraded: report.degraded,
      eventCount: report.eventCount,
      createdAt: report.createdAt,
    };
  },
});

/** Evidence events for a job (owner only), sorted high→low severity. */
export const getEvidence = query({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) return null;
    const events = await ctx.db
      .query("evidenceEvents")
      .withIndex("by_job_severity", (q) => q.eq("jobId", args.jobId))
      .collect();

    const order = { high: 0, medium: 1, low: 2 } as const;
    return events
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((e) => ({
        _id: e._id,
        category: e.category,
        severity: e.severity,
        confidence: e.confidence,
        sourceStart: e.sourceStart,
        sourceEnd: e.sourceEnd,
        editedStart: e.editedStart,
        editedEnd: e.editedEnd,
        evidenceType: e.evidenceType,
        explanation: e.explanation,
        observedChange: e.observedChange,
        contextualImpact: e.contextualImpact,
        sourceSegmentIds: e.sourceSegmentIds ?? [],
        editedSegmentIds: e.editedSegmentIds ?? [],
      }));
  },
});

/**
 * Transcript segments + alignment mappings for a job (owner only).
 * Returned together so the evidence panel can join events to transcript rows.
 */
export const getEvidenceDetail = query({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) return null;

    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();

    const source = segments
      .filter((s) => s.videoId === job.sourceVideoId)
      .sort((a, b) => a.startTime - b.startTime)
      .map((s) => ({
        _id: s._id,
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
        confidence: s.confidence,
      }));
    const edited = segments
      .filter((s) => s.videoId === job.editedVideoId)
      .sort((a, b) => a.startTime - b.startTime)
      .map((s) => ({
        _id: s._id,
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
        confidence: s.confidence,
      }));

    const mappings = await ctx.db
      .query("alignmentMappings")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();

    // Map segment index (as recorded by the pipeline) -> segment row.
    const sourceByIndex = new Map(source.map((s, i) => [i, s]));
    const editedByIndex = new Map(edited.map((s, i) => [i, s]));

    return {
      sourceTranscript: source,
      editedTranscript: edited,
      mappings: mappings.map((m) => ({
        _id: m._id,
        sourceIndex: m.sourceIndex,
        editedIndex: m.editedIndex,
        similarity: m.similarity,
        confidence: m.confidence,
        method: m.method,
        sourceSegment: sourceByIndex.get(m.sourceIndex) ?? null,
        editedSegment: editedByIndex.get(m.editedIndex) ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers (pipeline)
// ---------------------------------------------------------------------------

export const getJobInternal = internalQuery({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

export const getVideoInternal = internalQuery({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.videoId);
  },
});

export const createJobInternal = internalMutation({
  args: {
    ownerId: v.id("users"),
    sourceVideoId: v.id("videos"),
    editedVideoId: v.id("videos"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("analysisJobs", {
      ownerId: args.ownerId,
      sourceVideoId: args.sourceVideoId,
      editedVideoId: args.editedVideoId,
      status: "QUEUED",
      currentStage: "media_validation",
      progress: 0,
      pipelineVersion: "ctxtrace-engine v1.0.0 (demo-mode)",
      createdAt: Date.now(),
    });
  },
});

/** Complete the current stage: accumulate warnings, bump progress, set status. */
export const completeStageInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    stage: v.union(...PIPELINE_STAGES.map((s) => v.literal(s))),
    warnings: v.array(v.string()),
    modalityFailure: v.optional(
      v.object({ stage: v.string(), reason: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;

    const warnings = [...(job.warnings ?? [])];
    for (const w of args.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (args.modalityFailure) {
      const msg = `${args.modalityFailure.stage}: ${args.modalityFailure.reason}`;
      if (!warnings.includes(msg)) warnings.push(msg);
    }

    const stageProgress: Record<string, number> = {
      media_validation: 10,
      preprocessing: 18,
      speech_analysis: 34,
      semantic_alignment: 42,
      visual_evidence: 55,
      ocr_evidence: 66,
      edit_detection: 78,
      context_analysis: 88,
      report_generation: 100,
    };
    const progress = Math.max(job.progress, stageProgress[args.stage] ?? 0);
    const degraded =
      args.modalityFailure !== undefined || warnings.length > 0;

    await ctx.db.patch(args.jobId, {
      warnings,
      progress,
      status: degraded ? "DEGRADED" : "RUNNING",
    });
  },
});

export const advanceStageInternal = internalMutation({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const idx = PIPELINE_STAGES.indexOf(
      job.currentStage as (typeof PIPELINE_STAGES)[number],
    );
    const next = PIPELINE_STAGES[idx + 1];
    if (!next) return; // report_generation finalizes instead
    await ctx.db.patch(args.jobId, { currentStage: next });
  },
});

export const markFailedInternal = internalMutation({
  args: { jobId: v.id("analysisJobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: "FAILED",
      errorMessage: args.errorMessage,
      completedAt: Date.now(),
    });
  },
});

type PlacedSegment = TranscriptSegmentInput;

export const insertSegmentsInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    videoId: v.id("videos"),
    segments: v.array(
      v.object({
        index: v.number(),
        startTime: v.number(),
        endTime: v.number(),
        text: v.string(),
        confidence: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const seg of args.segments) {
      await ctx.db.insert("transcriptSegments", {
        videoId: args.videoId,
        jobId: args.jobId,
        startTime: seg.startTime,
        endTime: seg.endTime,
        text: seg.text,
        confidence: seg.confidence,
      });
    }
  },
});

export const setSpeechEvidenceInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    sourceSegments: v.array(
      v.object({
        index: v.number(),
        startTime: v.number(),
        endTime: v.number(),
        text: v.string(),
        confidence: v.number(),
      }),
    ),
    editedSegments: v.array(
      v.object({
        index: v.number(),
        startTime: v.number(),
        endTime: v.number(),
        text: v.string(),
        confidence: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      sourceSegmentsBuffer: args.sourceSegments,
      editedSegmentsBuffer: args.editedSegments,
    });
  },
});

export const setOcrEvidenceInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    sourceOcrText: v.array(v.string()),
    editedOcrText: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      sourceOcrBuffer: args.sourceOcrText,
      editedOcrBuffer: args.editedOcrText,
    });
  },
});

export const getAnalysisInputInternal = internalQuery({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return {
      sourceSegments: job.sourceSegmentsBuffer ?? [],
      editedSegments: job.editedSegmentsBuffer ?? [],
      sourceOcrText: job.sourceOcrBuffer,
      editedOcrText: job.editedOcrBuffer,
    };
  },
});

/** Run after edit_detection: persists mappings + evidence events from engine. */
export const setAnalysisInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    analysis: v.object({
      mappings: v.array(
        v.object({
          sourceIndex: v.number(),
          editedIndex: v.number(),
          similarity: v.number(),
          confidence: v.number(),
          method: v.string(),
        }),
      ),
      events: v.array(
        v.object({
          category: v.string(),
          severity: v.string(),
          confidence: v.number(),
          sourceStart: v.optional(v.number()),
          sourceEnd: v.optional(v.number()),
          editedStart: v.optional(v.number()),
          editedEnd: v.optional(v.number()),
          evidenceType: v.string(),
          explanation: v.string(),
          observedChange: v.string(),
          contextualImpact: v.string(),
          sourceSegmentIds: v.array(v.number()),
          editedSegmentIds: v.array(v.number()),
        }),
      ),
      score: v.number(),
      evidenceCoverage: v.number(),
      uncertainty: v.number(),
      matchThreshold: v.number(),
      strongThreshold: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const analysis = args.analysis;

    // Fetch persisted segment rows to resolve indices -> real segment ids.
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    const sourceRows = segments
      .filter((s) => s.videoId === job.sourceVideoId)
      .sort((a, b) => a.startTime - b.startTime);
    const editedRows = segments
      .filter((s) => s.videoId === job.editedVideoId)
      .sort((a, b) => a.startTime - b.startTime);

    for (const m of analysis.mappings) {
      const src = sourceRows[m.sourceIndex];
      const edit = editedRows[m.editedIndex];
      if (!src || !edit) continue;
      await ctx.db.insert("alignmentMappings", {
        jobId: args.jobId,
        sourceSegmentId: src._id,
        editedSegmentId: edit._id,
        sourceIndex: m.sourceIndex,
        editedIndex: m.editedIndex,
        similarity: m.similarity,
        confidence: m.confidence,
        method: m.method,
      });
    }

    for (const ev of analysis.events) {
      await ctx.db.insert("evidenceEvents", {
        jobId: args.jobId,
        category: ev.category as
          | "Omission"
          | "Reordering"
          | "Splicing"
          | "Discontinuity",
        severity: ev.severity as "low" | "medium" | "high",
        confidence: ev.confidence,
        sourceStart: ev.sourceStart,
        sourceEnd: ev.sourceEnd,
        editedStart: ev.editedStart,
        editedEnd: ev.editedEnd,
        evidenceType: ev.evidenceType as
          | "speech_alignment"
          | "visual_correspondence"
          | "ocr_caption"
          | "edit_event",
        explanation: ev.explanation,
        observedChange: ev.observedChange,
        contextualImpact: ev.contextualImpact,
        sourceSegmentIds: ev.sourceSegmentIds
          .map((i) => sourceRows[i]?._id)
          .filter((x): x is typeof sourceRows[number]["_id"] => Boolean(x)),
        editedSegmentIds: ev.editedSegmentIds
          .map((i) => editedRows[i]?._id)
          .filter((x): x is typeof editedRows[number]["_id"] => Boolean(x)),
      });
    }

    // Record model configuration and clear transient buffers.
    await ctx.db.patch(args.jobId, {
      modelConfiguration:
        `provider=demo_simulated_v1; asr=faster-whisper(simulated); embeddings=sentence-transformers(simulated); ` +
        `faiss=topk(simulated); openclip=ViT-B/32(simulated); paddleocr(simulated); ` +
        `matchThreshold=${analysis.matchThreshold.toFixed(2)}; strongThreshold=${analysis.strongThreshold.toFixed(2)}; ` +
        `mappings=${analysis.mappings.length}`,
      sourceSegmentsBuffer: undefined,
      editedSegmentsBuffer: undefined,
      sourceOcrBuffer: undefined,
      editedOcrBuffer: undefined,
    });
  },
});

export const finalizeAnalysisInternal = internalMutation({
  args: {
    jobId: v.id("analysisJobs"),
    pipelineVersion: v.string(),
    modelConfiguration: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;

    const events = await ctx.db
      .query("evidenceEvents")
      .withIndex("by_job_severity", (q) => q.eq("jobId", args.jobId))
      .collect();

    // Recompute score from persisted events — persisted rows are the single
    // source of truth for the report.
    const severityWeight = { high: 1.0, medium: 0.6, low: 0.3 } as const;
    const categoryWeight: Record<string, number> = {
      Omission: 0.35,
      Reordering: 0.18,
      Splicing: 0.22,
      Discontinuity: 0.12,
    };
    let penalty = 0;
    let highCount = 0;
    for (const ev of events) {
      const cw = categoryWeight[ev.category] ?? 0.1;
      penalty += cw * severityWeight[ev.severity] * (0.4 + ev.confidence * 0.6);
      if (ev.severity === "high") highCount++;
    }
    const score = Math.round(clamp01(1 - penalty) * 100);

    const sourceVideo = await ctx.db.get(job.sourceVideoId);
    const editedVideo = await ctx.db.get(job.editedVideoId);
    const bothAudio =
      (sourceVideo?.hasAudio ?? false) && (editedVideo?.hasAudio ?? false);
    const evidenceCoverage = clamp01(
      1 - (bothAudio ? 0 : 0.4) - (job.warnings?.length ?? 0) * 0.1,
    );
    const avgConfidence =
      events.length > 0
        ? events.reduce((acc, e) => acc + e.confidence, 0) / events.length
        : 0.5;
    const uncertainty = clamp01(
      events.length === 0
        ? 0.35 + (1 - evidenceCoverage) * 0.3
        : 0.9 - avgConfidence * 0.6 + (1 - evidenceCoverage) * 0.2,
    );

    // Caption/speech mismatch warning (supporting evidence only).
    let captionWarning: string | null = null;
    const ocrSource = job.sourceOcrBuffer;
    if (ocrSource && ocrSource.length > 0) {
      const check = checkCaptionMismatch(
        (job.sourceSegmentsBuffer ?? []) as PlacedSegment[],
        ocrSource,
      );
      if (check.warning) captionWarning = check.warning;
    }

    const warnings = [...(job.warnings ?? [])];
    if (captionWarning && !warnings.includes(captionWarning)) {
      warnings.push(captionWarning);
    }

    const degraded = warnings.length > 0;
    const interpretation = buildInterpretation(
      score,
      highCount,
      degraded,
      events.length,
    );

    const existing = await ctx.db
      .query("reports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("reports", {
      jobId: args.jobId,
      ownerId: job.ownerId,
      score,
      overallConfidence: clamp01(1 - uncertainty * 0.5),
      evidenceCoverage,
      uncertainty,
      interpretation,
      pipelineVersion: args.pipelineVersion,
      modelConfiguration: args.modelConfiguration,
      degraded,
      eventCount: events.length,
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.jobId, {
      status: degraded ? "DEGRADED" : "COMPLETED",
      currentStage: "report_generation",
      progress: 100,
      warnings,
      completedAt: Date.now(),
    });
  },
});

function buildInterpretation(
  score: number,
  highCount: number,
  degraded: boolean,
  eventCount: number,
): string {
  const parts: string[] = [];
  if (eventCount === 0) {
    parts.push(
      "The edited version preserves the source's spoken content: no material structural differences were detected by speech alignment.",
    );
  } else if (score >= 85) {
    parts.push(
      "The edited version is broadly consistent with the source; minor structural differences were detected.",
    );
  } else if (score >= 45) {
    parts.push(
      "The edit diverges materially from the source in places. Speech alignment found structural differences consistent with excerpting or re-editing.",
    );
  } else {
    parts.push(
      "The edit differs substantially from the source. Multiple structural differences consistent with heavy excerpting, reordering, or inserted material were detected.",
    );
  }
  if (highCount > 0) {
    parts.push(
      `${highCount} finding${highCount === 1 ? "" : "s"} carry high severity; review the evidence before drawing conclusions.`,
    );
  }
  if (degraded) {
    parts.push(
      "Note: one or more evidence modalities failed or were unavailable, so this assessment rests on partial evidence.",
    );
  }
  parts.push(
    "ContextTrace identifies evidence consistent with contextual change; it does not establish intent. Ordinary editing is not automatically misleading.",
  );
  return parts.join(" ");
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// Re-export for pipeline convenience (formatTimestamp used in evidence text).
export { formatTimestamp };
