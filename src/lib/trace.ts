// Shared client helpers for ContextTrace UI.

export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  media_validation: "Media Validation",
  preprocessing: "Pre-processing",
  speech_analysis: "Speech Analysis",
  semantic_alignment: "Semantic Alignment",
  visual_evidence: "Visual Evidence",
  ocr_evidence: "OCR Evidence",
  edit_detection: "Edit Detection",
  context_analysis: "Context Analysis",
  report_generation: "Report Generation",
};

export const PIPELINE_STAGE_ORDER = Object.keys(PIPELINE_STAGE_LABELS);

export function stageIndex(stage?: string | null): number {
  if (!stage) return -1;
  return PIPELINE_STAGE_ORDER.indexOf(stage);
}

export function formatTimestamp(seconds?: number | null): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${ms}`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatPercent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// Status / severity presentation
// ---------------------------------------------------------------------------

export type JobStatus = "QUEUED" | "RUNNING" | "DEGRADED" | "COMPLETED" | "FAILED";

export type JobMode = "compare" | "scan" | "mitigation";

export const MODE_BADGE: Record<JobMode, { label: string; className: string }> = {
  compare: {
    label: "COMPARE",
    className: "bg-muted text-muted-foreground border border-border",
  },
  scan: {
    label: "AI-SCAN",
    className: "bg-[var(--trace-blue-soft)] text-[var(--trace-blue)] border border-[var(--trace-blue)]/30",
  },
  mitigation: {
    label: "MITIGATED",
    className: "bg-foreground text-background border border-foreground",
  },
};

export function aiScoreBand(score: number): { label: string; className: string } {
  if (score >= 70)
    return { label: "AI signatures likely", className: "text-[var(--trace-red)]" };
  if (score >= 45)
    return { label: "Gray zone — artifacts present", className: "text-[var(--trace-red)]" };
  if (score >= 25)
    return { label: "Low artifact load", className: "text-foreground" };
  return { label: "No measurable AI signatures", className: "text-[var(--trace-blue)]" };
}

export const STATUS_CLASSES: Record<JobStatus, string> = {
  QUEUED: "bg-muted text-muted-foreground border border-border",
  RUNNING: "bg-[var(--trace-blue-soft)] text-[var(--trace-blue)] border border-[var(--trace-blue)]/30",
  DEGRADED: "bg-[var(--trace-red-soft)] text-[var(--trace-red)] border border-[var(--trace-red)]/30",
  COMPLETED: "bg-[var(--trace-blue)] text-white border border-[var(--trace-blue)]",
  FAILED: "bg-[var(--trace-red)] text-white border border-[var(--trace-red)]",
};

export const SEVERITY_CLASSES: Record<string, string> = {
  high: "bg-[var(--trace-red)] text-white border border-[var(--trace-red)]",
  medium: "bg-[var(--trace-red-soft)] text-[var(--trace-red)] border border-[var(--trace-red)]/30",
  low: "bg-muted text-muted-foreground border border-border",
};

export const CATEGORY_CLASSES: Record<string, string> = {
  Omission: "bg-[var(--trace-red-soft)] text-[var(--trace-red)] border border-[var(--trace-red)]/30",
  Reordering: "bg-[var(--trace-blue-soft)] text-[var(--trace-blue)] border border-[var(--trace-blue)]/30",
  Splicing: "bg-[var(--trace-red-soft)] text-[var(--trace-red)] border border-[var(--trace-red)]/30",
  Discontinuity: "bg-muted text-foreground border border-border",
  "Caption/Speech Mismatch": "bg-muted text-foreground border border-border",
};

export function scoreBand(score: number): {
  label: string;
  className: string;
} {
  if (score >= 85)
    return { label: "Consistent", className: "text-[var(--trace-blue)]" };
  if (score >= 45)
    return { label: "Materially edited", className: "text-[var(--trace-red)]" };
  return { label: "Heavily restructured", className: "text-[var(--trace-red)]" };
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Demo mode notice — must always be visible wherever analysis data appears.
// ---------------------------------------------------------------------------

export const DEMO_NOTICE =
  "DEMO MODE — speech, OCR and visual evidence are synthesized by deterministic simulators; alignment, detection and scoring logic run for real on that evidence.";

export function isDemoMode(): boolean {
  return true;
}
