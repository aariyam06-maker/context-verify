import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { PIPELINE_STAGES } from "./schema";
import type { TranscriptSegmentInput } from "./engine";
import { checkCaptionMismatch, formatTimestamp } from "./engine";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a job from two uploaded videos, validate ownership, start pipeline. */
export const createJob = mutation({
  args: {
    sourceVideoId: v.id("videos"),
    editedVideoId: v.id("videos"),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");

    const source = await ctx.db.get(args.sourceVideoId);
    const edited = await ctx.db.get(args.editedVideoId);
    if (
      !source ||
      !edited ||
      source.ownerId !== userId ||
      edited.ownerId !== userId
    ) {
      throw new Error("Videos not found or not owned by you.");
    }
    if (
      source.validationStatus !== "uploaded" ||
      edited.validationStatus !== "uploaded"
    ) {
      throw new Error("Both videos must pass validation before analysis.");
    }

    const jobId = await ctx.db.insert("analysisJobs", {
      ownerId: userId,
      mode: "compare",
      sourceVideoId: args.sourceVideoId,
      editedVideoId: args.editedVideoId,
      status: "QUEUED",
      currentStage: "media_validation",
      progress: 0,
      pipelineVersion: "ctxtrace-engine v1.0.0 (demo-mode)",
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.pipeline.startStage, { jobId });
    return jobId;
  },
});

// ---------------------------------------------------------------------------
// Job queries (public, ownership-checked)
// ---------------------------------------------------------------------------

/**
 * Create a single-video scan job (no source video required). The pipeline
 * stages run client-side in the ScanWorkbench; this row tracks status/history.
 */
export const createScanJob = mutation({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");
    const video = await ctx.db.get(args.videoId);
    if (!video || video.ownerId !== userId) {
      throw new Error("Video not found or not owned by you.");
    }
    if (video.validationStatus !== "uploaded") {
      throw new Error("Video must pass validation before scanning.");
    }

    const jobId = await ctx.db.insert("analysisJobs", {
      ownerId: userId,
      mode: "scan",
      sourceVideoId: args.videoId,
      status: "QUEUED",
      currentStage: "media_validation",
      progress: 0,
      pipelineVersion: "ctxtrace-engine v1.1.0 (ai-scan)",
      createdAt: Date.now(),
    });
    return jobId;
  },
});

/**
 * Persist a completed client-side scan: findings rows + a report with the full
 * machine-readable scan result. Called by the ScanWorkbench when the browser
 * analysis finishes.
 */
export const finalizeScanReport = mutation({
  args: {
    jobId: v.id("analysisJobs"),
    result: v.object({
      analyzedFrames: v.number(),
      sampledAt: v.array(v.number()),
      aiScore: v.number(),
      confidence: v.number(),
      durationSeconds: v.number(),
      components: v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          score: v.number(),
          confidence: v.number(),
          summary: v.string(),
        }),
      ),
      findings: v.array(
        v.object({
          componentId: v.string(),
          label: v.string(),
          severity: v.string(),
          score: v.number(),
          timestamp: v.number(),
          frameValue: v.number(),
          breachPct: v.number(),
          explanation: v.string(),
        }),
      ),
      meta: v.object({
        width: v.number(),
        height: v.number(),
        fpsEstimate: v.optional(v.number()),
        hasAudio: v.boolean(),
      }),
    }),
    degraded: v.boolean(),
    warnings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) {
      throw new Error("Job not found or not owned by you.");
    }
    if (job.mode !== "scan" && job.mode !== "mitigation") {
      throw new Error("finalizeScanReport applies only to scan/mitigation jobs.");
    }
    if (args.result.analyzedFrames <= 0) {
      throw new Error("Scan produced no analyzed frames.");
    }

    // Replace any prior scan findings/report (idempotent re-finalize).
    const priorFindings = await ctx.db
      .query("scanFindings")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const f of priorFindings) await ctx.db.delete(f._id);
    const priorReports = await ctx.db
      .query("reports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const r of priorReports) await ctx.db.delete(r._id);

    for (const f of args.result.findings) {
      await ctx.db.insert("scanFindings", {
        jobId: args.jobId,
        componentId: f.componentId,
        label: f.label,
        severity: f.severity as "low" | "medium" | "high",
        score: f.score,
        timestamp: f.timestamp,
        frameValue: f.frameValue,
        breachPct: f.breachPct,
        explanation: f.explanation,
      });
    }

    const score = args.result.aiScore;
    const interpretation = buildScanInterpretation(
      score,
      args.result.confidence,
      args.result.findings.length,
      args.degraded,
    );

    await ctx.db.insert("reports", {
      jobId: args.jobId,
      ownerId: userId,
      score,
      overallConfidence: args.result.confidence,
      evidenceCoverage: Math.min(1, args.result.analyzedFrames / 24),
      uncertainty: Math.max(0.1, 1 - args.result.confidence * 0.8),
      interpretation,
      pipelineVersion: job.pipelineVersion,
      modelConfiguration:
        `ai-scan v1; frames=${args.result.analyzedFrames}; ` +
        `components=blockiness,temporal_flicker,saturation_dev,texture_uniformity,compression_noise,frequency_energy; ` +
        `exec=browser(canvas+typed arrays)`,
      degraded: args.degraded,
      eventCount: args.result.findings.length,
      mode: job.mode,
      aiScore: score,
      scanResult: args.result,
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.jobId, {
      status: args.degraded ? "DEGRADED" : "COMPLETED",
      currentStage: "report_generation",
      progress: 100,
      warnings: args.warnings,
      startedAt: job.startedAt ?? Date.now(),
      completedAt: Date.now(),
    });
  },
});

/** Attach a mitigation outcome (before/after + cleaned-video storage key). */
export const saveMitigationResult = mutation({
  args: {
    jobId: v.id("analysisJobs"),
    aiBefore: v.number(),
    aiAfter: v.number(),
    passesApplied: v.array(v.string()),
    outputStorageKey: v.string(),
    outputByteSize: v.number(),
    outputDurationSeconds: v.number(),
    outputWidth: v.number(),
    outputHeight: v.number(),
    deltas: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        before: v.number(),
        after: v.number(),
        changePct: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) {
      throw new Error("Job not found or not owned by you.");
    }

    const report = await ctx.db
      .query("reports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .filter((q) => q.eq(q.field("ownerId"), userId))
      .first();
    if (!report) throw new Error("Run the AI scan before mitigation.");

    await ctx.db.patch(report._id, {
      mitigation: {
        aiBefore: args.aiBefore,
        aiAfter: args.aiAfter,
        passesApplied: args.passesApplied,
        outputByteSize: args.outputByteSize,
        outputDurationSeconds: args.outputDurationSeconds,
        outputStorageKey: args.outputStorageKey,
        deltas: args.deltas,
      },
    });

    await ctx.db.patch(args.jobId, {
      mode: "mitigation",
      currentStage: "report_generation",
      status: args.aiAfter < args.aiBefore ? "COMPLETED" : "DEGRADED",
      completedAt: Date.now(),
    });

    // Register the cleaned derivative as a "scan" video so History rows show it.
    await ctx.db.insert("videos", {
      ownerId: userId,
      type: "scan",
      filename: "cleaned-output.webm",
      mimeType: "video/webm",
      byteSize: args.outputByteSize,
      storageKey: args.outputStorageKey,
      durationSeconds: args.outputDurationSeconds,
      width: args.outputWidth,
      height: args.outputHeight,
      hasAudio: true,
      validationStatus: "uploaded",
      validationMessage: "Mitigated derivative generated client-side.",
      createdAt: Date.now(),
    });
  },
});

/** Job with joined video records — used by progress + report pages. */
export const getJob = query({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) return null;

    const sourceVideo = job.sourceVideoId
      ? await ctx.db.get(job.sourceVideoId)
      : null;
    const editedVideo = job.editedVideoId
      ? await ctx.db.get(job.editedVideoId)
      : null;

    const videoShape = (
      vid: { _id: string; filename: string; durationSeconds?: number; hasAudio?: boolean; byteSize: number; mimeType: string; storageKey?: string } | null,
    ) =>
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
      mode: job.mode ?? "compare",
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
        const sourceVideo = job.sourceVideoId
          ? await ctx.db.get(job.sourceVideoId)
          : null;
        const editedVideo = job.editedVideoId
          ? await ctx.db.get(job.editedVideoId)
          : null;
        return {
          _id: job._id,
          mode: job.mode ?? "compare",
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
                mode: report.mode ?? "compare",
                aiScore: report.aiScore,
                mitigated: report.mitigation !== undefined,
              }
            : null,
        };
      }),
    );
  },
});

/** Retry a failed job: reset it and re-run the pipeline from stage 1. */
export const retryJob = mutation({
  args: { jobId: v.id("analysisJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.ownerId !== userId) {
      throw new Error("Job not found or not owned by you.");
    }
    if (job.status !== "FAILED") {
      throw new Error("Only failed jobs can be retried.");
    }

    // Clean prior artifacts so the re-run is deterministic.
    const events = await ctx.db
      .query("evidenceEvents")
      .withIndex("by_job_severity", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const e of events) await ctx.db.delete(e._id);
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of segments) await ctx.db.delete(s._id);
    const reports = await ctx.db
      .query("reports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const r of reports) await ctx.db.delete(r._id);

    await ctx.db.patch(args.jobId, {
      status: "QUEUED",
      currentStage: "media_validation",
      progress: 0,
      errorMessage: undefined,
      warnings: [],
      sourceSegmentsBuffer: undefined,
      editedSegmentsBuffer: undefined,
      sourceOcrBuffer: undefined,
      editedOcrBuffer: undefined,
      completedAt: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.pipeline.startStage, {
      jobId: args.jobId,
    });
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

    const sourceVideo = job.sourceVideoId
      ? await ctx.db.get(job.sourceVideoId)
      : null;
    const editedVideo = job.editedVideoId
      ? await ctx.db.get(job.editedVideoId)
      : null;
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

function buildScanInterpretation(
  score: number,
  confidence: number,
  findingCount: number,
  degraded: boolean,
): string {
  const parts: string[] = [];
  if (findingCount === 0) {
    parts.push(
      "No component breached its calibrated threshold: the footage shows no measurable AI-generation or over-processing artifacts in this scan.",
    );
  } else if (score >= 70) {
    parts.push(
      `Multiple forensic components (${findingCount}) breach calibrated thresholds, consistent with AI-generated or heavily synthetic footage.`,
    );
  } else if (score >= 45) {
    parts.push(
      `${findingCount} component${findingCount === 1 ? "" : "s"} show artifact signatures in the gray zone — consistent with heavy compression, upscaling, or light generative post-processing.`,
   );}
  else {
    parts.push(
      `${findingCount} low-level component signature${findingCount === 1 ? "" : "s"} detected; overall artifacts are mild and could easily come from ordinary encoding.`,
    );
  }
  if (confidence < 0.5) {
    parts.push(
      "Measurement confidence is reduced (short clip, low resolution, or missing audio); treat the score as indicative only.",
    );
  }
  if (degraded) {
    parts.push(
      "One or more scan components could not be measured; the result rests on partial evidence.",
    );
  }
  parts.push(
    "This scan measures generation/processing artifacts, not the semantic truth of the content; scores are forensic indicators with stated uncertainty, never proof.",
  );
  return parts.join(" ");
}

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

// Re-export engine helpers used by scan interpretation (kept for API parity).
export { checkCaptionMismatch };
