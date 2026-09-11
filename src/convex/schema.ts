import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// ---------------------------------------------------------------------------
// Role model
// ---------------------------------------------------------------------------

export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------

export const VIDEO_TYPES = ["source", "edited"] as const;
export const VIDEO_STATUSES = [
  "uploaded", // stored, metadata extracted, ready for analysis
  "invalid", // failed validation (corrupt, unsupported, too large)
] as const;

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "DEGRADED",
  "COMPLETED",
  "FAILED",
] as const;

export const PIPELINE_STAGES = [
  "media_validation",
  "preprocessing",
  "speech_analysis",
  "semantic_alignment",
  "visual_evidence",
  "ocr_evidence",
  "edit_detection",
  "context_analysis",
  "report_generation",
] as const;

export const EVENT_CATEGORIES = [
  "Omission",
  "Reordering",
  "Splicing",
  "Caption/Speech Mismatch",
  "Discontinuity",
] as const;

export const SEVERITIES = ["low", "medium", "high"] as const;
export const EVIDENCE_TYPES = [
  "speech_alignment",
  "visual_correspondence",
  "ocr_caption",
  "edit_event",
  "metadata",
] as const;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // -----------------------------------------------------------------------
    // ContextTrace domain tables
    // -----------------------------------------------------------------------

    videos: defineTable({
      ownerId: v.id("users"),
      type: v.union(...VIDEO_TYPES.map((t) => v.literal(t))),
      filename: v.string(),
      mimeType: v.string(),
      byteSize: v.number(),
      // storage is browser-local (IndexedDB via the upload page); we persist a
      // reference key so the owner's session can replay the file. Convex file
      // storage is not used in v1.
      storageKey: v.optional(v.string()),
      durationSeconds: v.optional(v.number()),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
      hasAudio: v.optional(v.boolean()),
      validationStatus: v.union(...VIDEO_STATUSES.map((s) => v.literal(s))),
      validationMessage: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_owner", ["ownerId", "createdAt"])
      .index("by_owner_type", ["ownerId", "type"]),

    analysisJobs: defineTable({
      ownerId: v.id("users"),
      sourceVideoId: v.id("videos"),
      editedVideoId: v.id("videos"),
      status: v.union(...JOB_STATUSES.map((s) => v.literal(s))),
      currentStage: v.optional(
        v.union(...PIPELINE_STAGES.map((s) => v.literal(s))),
      ),
      progress: v.number(), // 0..100
      pipelineVersion: v.string(),
      modelConfiguration: v.optional(v.string()),
      errorMessage: v.optional(v.string()),
      warnings: v.optional(v.array(v.string())),
      startedAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      createdAt: v.number(),

      // Transient per-job evidence buffers exchanged between pipeline stages
      // (cleared after analysis is persisted to the domain tables).
      sourceSegmentsBuffer: v.optional(
        v.array(
          v.object({
            index: v.number(),
            startTime: v.number(),
            endTime: v.number(),
            text: v.string(),
            confidence: v.number(),
          }),
        ),
      ),
      editedSegmentsBuffer: v.optional(
        v.array(
          v.object({
            index: v.number(),
            startTime: v.number(),
            endTime: v.number(),
            text: v.string(),
            confidence: v.number(),
          }),
        ),
      ),
      sourceOcrBuffer: v.optional(v.array(v.string())),
      editedOcrBuffer: v.optional(v.array(v.string())),
    })
      .index("by_owner_created", ["ownerId", "createdAt"])
      .index("by_status", ["status"]),

    transcriptSegments: defineTable({
      videoId: v.id("videos"),
      jobId: v.id("analysisJobs"),
      speaker: v.optional(v.string()),
      startTime: v.number(),
      endTime: v.number(),
      text: v.string(),
      confidence: v.number(), // 0..1
      // language: v.optional(v.string()),
    }).index("by_job", ["jobId", "startTime"]),

    alignmentMappings: defineTable({
      jobId: v.id("analysisJobs"),
      sourceSegmentId: v.id("transcriptSegments"),
      editedSegmentId: v.id("transcriptSegments"),
      sourceIndex: v.number(), // index within source transcript order
      editedIndex: v.number(),
      similarity: v.number(), // 0..1 cosine similarity
      confidence: v.number(), // 0..1 mapping confidence
      method: v.string(), // e.g. "greedy_threshold_v1"
    }).index("by_job", ["jobId"]),

    evidenceEvents: defineTable({
      jobId: v.id("analysisJobs"),
      category: v.union(...EVENT_CATEGORIES.map((c) => v.literal(c))),
      severity: v.union(...SEVERITIES.map((s) => v.literal(s))),
      confidence: v.number(), // 0..1 confidence in the *observation*
      sourceStart: v.optional(v.number()),
      sourceEnd: v.optional(v.number()),
      editedStart: v.optional(v.number()),
      editedEnd: v.optional(v.number()),
      evidenceType: v.union(...EVIDENCE_TYPES.map((e) => v.literal(e))),
      explanation: v.string(),
      observedChange: v.string(),
      contextualImpact: v.string(),
      // Optional linked transcript segment ids for the evidence panel
      sourceSegmentIds: v.optional(v.array(v.id("transcriptSegments"))),
      editedSegmentIds: v.optional(v.array(v.id("transcriptSegments"))),
    }).index("by_job_severity", ["jobId"]),

    reports: defineTable({
      jobId: v.id("analysisJobs"),
      ownerId: v.id("users"),
      score: v.number(), // 0..100 Context Integrity Score
      overallConfidence: v.number(), // 0..1
      evidenceCoverage: v.number(), // 0..1
      uncertainty: v.number(), // 0..1
      interpretation: v.string(),
      pipelineVersion: v.string(),
      modelConfiguration: v.string(),
      degraded: v.boolean(),
      eventCount: v.number(),
      createdAt: v.number(),
    }).index("by_job", ["jobId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
