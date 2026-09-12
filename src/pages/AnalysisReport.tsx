import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/AppShell";
import {
  SCAN_COMPONENTS,
  planMitigation,
  type ComponentFinding,
  type ScanResult,
} from "@/lib/ai-scan";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import {
  formatDuration,
  formatPercent,
  SEVERITY_CLASSES,
} from "@/lib/trace";
import { cn } from "@/lib/utils";
import {
  BookmarkCheck,
  FileVideo,
  RotateCcw,
  ScanLine,
  ScrollText,
  ShieldAlert,
  Video,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Id } from "@/convex/_generated/dataModel";

export type EligibilityFinding = {
  label: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  explanation: string;
  source?: number;
  edited?: number;
};

function scanResultFromJob(
  report: NonNullable<ReturnType<typeof useQuery> extends infer Q
    ? Q extends null
      ? never
      : Q
    : never>["report"],
): ScanResult | null {
  try {
    const r = report?.scanResult;
    if (!r) return null;
    return r as unknown as ScanResult;
  } catch {
    return null;
  }
}

function eligibilityFindingsFromJob(
  report: NonNullable<ReturnType<typeof useQuery> extends infer Q
    ? Q extends null
      ? never
      : Q
    : never>["report"],
): EligibilityFinding[] {
  const rows: EligibilityFinding[] = [];
  for (const ev of report?.findings ?? []) {
    rows.push({
      label: ev.category ?? "Finding",
      severity: (ev.severity ?? "low") as EligibilityFinding["severity"],
      confidence: ev.confidence ?? 0,
      explanation: ev.explanation ?? "",
      source: ev.sourceStart ?? undefined,
      edited: ev.editedStart ?? undefined,
    });
  }
  return rows;
}

function ScanResultBlock({
  result,
  onResample,
}: {
  result: ScanResult;
  onResample: () => void;
}) {
  const findings: ComponentFinding[] = result.findings ?? [];
  const band = {
    low: { label: "Low AItrace signal", className: "text-[var(--trace-blue)]" },
    mid: { label: "Moderate AItrace signal", className: "text-[var(--trace-red)]/80" },
    high: { label: "Strong AItrace signal", className: "text-[var(--trace-red)]" },
  }[result.aiScore >= 70 ? "high" : result.aiScore >= 45 ? "mid" : "low"];

  return (
    <section className="border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="meta-label flex items-center gap-1.5">
            <ScanLine className="size-3" /> AI Content Scan
          </p>
          <h2 className="mt-1 text-lg font-bold">Single-video forensic report</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Artifact-based scan of the edited video. Reads pixels directly from the
            uploaded file; not a semantic comparison and not proof of origin.
          </p>
        </div>
        {result.aiScore >= 45 && (
          <Button variant="outline" size="sm" onClick={onResample}>
            <RotateCcw className="size-3.5" /> Rerun scan
          </Button>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="border-b p-6 lg:border-b-0 lg:border-r">
          <p className="meta-label">AI Content Likelihood</p>
          <div className="mt-2 flex items-baseline gap-3">
            <span className={cn("text-6xl font-bold leading-none tracking-tight", band.className)}>
              {result.aiScore}
            </span>
            <span className="meta-label pb-2">% AI-detected</span>
          </div>
          <p className={cn("meta-label mt-3", band.className)}>{band.label}</p>
          <div className="mt-4 h-2 w-full border">
            <div
              className={cn(
                "h-full",
                result.aiScore >= 70 ? "bg-[var(--trace-red)]" : result.aiScore >= 45 ? "bg-[var(--trace-red)]/70" : "bg-[var(--trace-blue)]",
              )}
              style={{ width: `${result.aiScore}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-px border bg-border">
            <div className="bg-card p-2.5">
              <p className="meta-label">confidence</p>
              <p className="meta-value mt-0.5 text-foreground">{formatPercent(result.confidence)}</p>
            </div>
            <div className="bg-card p-2.5">
              <p className="meta-label">frames</p>
              <p className="meta-value mt-0.5 text-foreground">{result.analyzedFrames}</p>
            </div>
          </div>
        </div>

        <div className="p-6">
          <p className="meta-label">Component breakdown</p>
          <p className="text-xs text-muted-foreground">
            Each component normalized to 0..1 against documented calibration anchors (approximations from natural-video baselines). Weighted mean × 100 is the reported score.
          </p>
          <div className="mt-3 space-y-3">
            {result.components.map((c) => (
              <div key={c.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium tracking-tight">{c.label}</span>
                  <span className="meta-value tabular-nums text-muted-foreground">
                    {Math.round(c.score * 100)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full bg-secondary">
                  <div
                    className={cn(
                      "h-full",
                      c.score >= 0.55 ? "bg-[var(--trace-red)]" : c.score >= 0.35 ? "bg-[var(--trace-red)]/50" : "bg-[var(--trace-blue)]/60",
                    )}
                    style={{ width: `${Math.round(c.score * 100)}%` }}
                  />
                </div>
                <p className="meta-label mt-1 leading-4 text-muted-foreground">{c.summary}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 border-t bg-secondary/60 px-4 py-2">
            <DiagnosticsPanel
              components={result.components.map((c) => ({
                id: c.id,
                label: c.label,
                score: c.score,
                confidence: c.confidence,
                summary: c.summary,
              }))}
              aiScore={result.aiScore}
              confidence={result.confidence}
            />
          </div>
        </div>
      </div>

      {findings.length > 0 && (
        <div className="mt-6 border-t pt-6">
          <h3 className="text-sm font-semibold tracking-tight">
            Findings
            <span className="meta-label ml-2">{findings.length} components breached</span>
          </h3>
          <div className="mt-4 space-y-px border bg-border">
            {findings.map((f) => {
              const comp = SCAN_COMPONENTS.find((c) => c.id === f.componentId) ?? null;
              return (
                <div key={f.componentId} className="bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold tracking-tight">{f.label}</span>
                    <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold tracking-widest", SEVERITY_CLASSES[f.severity])}>
                      {f.severity.toUpperCase()}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    <span className="meta-label">timestamp <span className="text-foreground">{formatDuration(f.timestamp)}</span></span>
                    <span className="meta-label">breach <span className="text-foreground">{f.breachPct}%</span> of frames</span>
                    <span className="meta-label">score <span className="text-foreground">{Math.round(f.score * 100)}%</span></span>
                  </div>
                  <p className="mt-2 leading-5 text-muted-foreground">{f.explanation}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function EligibilityBlock({ findings }: { findings: EligibilityFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <section className="border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="meta-label flex items-center gap-1.5">
            <ScrollText className="size-3" /> Edit-impact assessment
          </p>
          <h2 className="mt-1 text-lg font-bold">Contextual editing findings</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Evidence-backed edits detected between the source and edited video.
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-px border bg-border">
        {findings.map((r, i) => (
          <div key={i} className="bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold tracking-tight">{r.label}</span>
              <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold tracking-widest", SEVERITY_CLASSES[r.severity])}>
                {r.severity.toUpperCase()}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              {r.source != null && <span className="meta-label">source <span className="text-foreground">{formatDuration(r.source)}</span></span>}
              {r.edited != null && <span className="meta-label">edited <span className="text-foreground">{formatDuration(r.edited)}</span></span>}
              <span className="meta-label">confidence <span className="text-foreground">{formatPercent(r.confidence)}</span></span>
            </div>
            <p className="mt-2 leading-5 text-muted-foreground">{r.explanation}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

type JobShape = NonNullable<
  Awaited<ReturnType<typeof useQuery<typeof api.jobs.getJob>>>
>;

function MetaCard({ job }: { job: JobShape }) {
  return (
    <div className="grid gap-px border bg-border md:grid-cols-2 lg:grid-cols-4">
      <div className="bg-card p-3">
        <p className="meta-label">Job</p>
        <p className="meta-value mt-1 text-foreground font-mono text-sm">{job._id.slice(0, 12)}…</p>
      </div>
      <div className="bg-card p-3">
        <p className="meta-label">Status</p>
        <p className="meta-value mt-1 text-foreground capitalize">{job.status.replace(/_/g, " ")}</p>
      </div>
      <div className="bg-card p-3">
        <p className="meta-label">Created</p>
        <p className="meta-value mt-1 text-foreground text-sm">
          {job.createdAt ? new Date(job.createdAt).toLocaleString() : "—"}
        </p>
      </div>
      <div className="bg-card p-3">
        <p className="meta-label">Completed</p>
        <p className="meta-value mt-1 text-foreground text-sm">
          {job.completedAt ? new Date(job.completedAt).toLocaleString() : "pending"}
        </p>
      </div>
    </div>
  );
}

function reportFromJob(job: JobShape) {
  // getJob only returns a joined report when the backend includes it; fall back
  // to null if the field is missing so the UI degrades gracefully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (job as any).report ?? null;
}

export default function AnalysisReport() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("job") ?? null;

  const job = useQuery(
    api.jobs.getJob,
    jobId ? { jobId: jobId as Id<"analysisJobs"> } : "skip",
  );

  const report = useMemo(() => (job ? reportFromJob(job) : null), [job]);

  const sourceVideo = useQuery(
    api.videos.getOwned,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job && (job as any).sourceVideoId ? { videoId: (job as any).sourceVideoId } : "skip",
  );
  const editedVideo = useQuery(
    api.videos.getOwned,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job && (job as any).editedVideoId ? { videoId: (job as any).editedVideoId } : "skip",
  );

  const scanResult = useMemo<ScanResult | null>(() => {
    if (!report) return null;
    return scanResultFromJob(report);
  }, [report]);

  const eligibility = useMemo<EligibilityFinding[]>(() => {
    if (!report) return [];
    return eligibilityFindingsFromJob(report);
  }, [report]);

  const showScan = useMemo(
    () => (scanResult ? scanResult.analyzedFrames > 0 : false),
    [scanResult],
  );

  const recap = useMemo(() => {
    const parts: string[] = [];
    if (sourceVideo?.filename) parts.push(`source ${sourceVideo.filename}`);
    if (editedVideo?.filename) parts.push(`edited ${editedVideo.filename}`);
    return parts.join(" · ") || "Analysis report";
  }, [sourceVideo, editedVideo]);

  const handleResample = useCallback(() => {
    if (!jobId) return;
    navigate(`/scan/${jobId}`, { replace: true });
  }, [navigate, jobId]);

  if (!job) {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <p className="meta-label">Report not found</p>
          <Button asChild variant="outline">
            <Link to="/history">Back to history</Link>
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Analysis Report</p>
          <h1 className="display-lg mt-2 text-3xl">{recap}</h1>
        </div>
        <nav className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/history">
              <BookmarkCheck className="size-4" /> History
            </Link>
          </Button>
        </nav>
      </div>

      <MetaCard job={job} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {sourceVideo?.filename ? (
          <div className="border bg-card p-4">
            <p className="meta-label font-semibold text-[var(--trace-blue)]">SOURCE VIDEO</p>
            <div className="mt-2 flex items-center gap-3">
              <Video className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{sourceVideo.filename}</span>
              {sourceVideo.durationSeconds != null && sourceVideo.durationSeconds > 0 && (
                <span className="meta-label shrink-0">{formatDuration(sourceVideo.durationSeconds)}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="border bg-secondary/40 p-8 text-center">
            <p className="meta-label">No source video</p>
          </div>
        )}
        {editedVideo?.filename ? (
          <div className="border bg-card p-4">
            <p className="meta-label font-semibold">EDITED VIDEO</p>
            <div className="mt-2 flex items-center gap-3">
              <FileVideo className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{editedVideo.filename}</span>
              {editedVideo.durationSeconds != null && editedVideo.durationSeconds > 0 && (
                <span className="meta-label shrink-0">{formatDuration(editedVideo.durationSeconds)}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="border bg-secondary/40 p-8 text-center">
            <p className="meta-label">No edited video</p>
          </div>
        )}
      </div>

      {report && (
        <section className="mt-6 border bg-card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="meta-label flex items-center gap-1.5">
                <ShieldAlert className="size-3" /> Interpretation
              </p>
              <h2 className="mt-1 text-lg font-bold">Contextual impact summary</h2>
            </div>
          </div>
          <p className="mt-3 leading-6 text-foreground/90">
            {report.interpretation ?? "No interpretation recorded."}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-px border bg-border">
            <div className="bg-card p-3">
              <p className="meta-label">Score</p>
              <p className="meta-value mt-1 text-foreground text-2xl font-bold">
                {report.score ?? 0}%
              </p>
            </div>
            <div className="bg-card p-3">
              <p className="meta-label">Overall confidence</p>
              <p className="meta-value mt-1 text-foreground">
                {formatPercent(report.overallConfidence ?? 0)}
              </p>
            </div>
          </div>
          <p className="mt-4 meta-label text-muted-foreground">
            Pipeline {report.pipelineVersion ?? "—"} · model{" "}
            {report.modelConfiguration ?? "—"}
          </p>
        </section>
      )}

      {eligibility.length > 0 && <EligibilityBlock findings={eligibility} />}

      {showScan && <ScanResultBlock result={scanResult as ScanResult} onResample={handleResample} />}

      {!showScan && eligibility.length === 0 && (
        <section className="mt-6 border bg-secondary/40 p-10 text-center">
          <p className="meta-label">No findings in this report</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The analysis did not detect edit-impact evidence or run an AI scan.
          </p>
          <Button asChild variant="outline" className="mt-4">
            <Link to="/new-analysis">
              <RotateCcw className="size-4" /> New analysis
            </Link>
          </Button>
        </section>
      )}
    </AppShell>
  );
}
