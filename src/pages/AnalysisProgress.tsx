import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { PipelineStepper, WarningList } from "@/components/PipelineStepper";
import {
  PIPELINE_STAGE_LABELS,
  STATUS_CLASSES,
  DEMO_NOTICE,
  formatDateTime,
} from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useParams } from "react-router";
import type { Id } from "@/convex/_generated/dataModel";
import type { JobStatus } from "@/lib/trace";

function Elapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!since || now === null) return <span className="meta-value">0:00</span>;
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return (
    <span className="meta-value tabular-nums">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export default function AnalysisProgress() {
  const { jobId } = useParams<{ jobId: string }>();
  const job = useQuery(
    api.jobs.getJob,
    jobId ? { jobId: jobId as Id<"analysisJobs"> } : "skip",
  );
  const retry = useMutation(api.jobs.retryJob);
  const navigate = useNavigate();

  useEffect(() => {
    if (
      job &&
      (job.status === "COMPLETED" || job.status === "DEGRADED")
    ) {
      const t = window.setTimeout(() => {
        navigate(`/analysis/${jobId}`, { replace: true });
      }, 900);
      return () => window.clearTimeout(t);
    }
  }, [job, jobId, navigate]);

  if (job === undefined) {
    return (
      <AppShell>
        <div className="flex items-center gap-3 py-24">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="meta-label">Loading job…</span>
        </div>
      </AppShell>
    );
  }

  if (job === null) {
    return (
      <AppShell>
        <div className="py-24 text-center">
          <p className="meta-label text-[var(--trace-red)]">404</p>
          <h1 className="display-lg mt-2 text-3xl">Analysis not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This job does not exist or belongs to another account.
          </p>
          <Button className="mt-6" asChild>
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </AppShell>
    );
  }

  const failed = job.status === "FAILED";

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Step 2 of 2 · Processing</p>
          <h1 className="display-lg mt-2 text-4xl">Analysis Progress</h1>
        </div>
        <div className="text-right">
          <p className="meta-label">Job ID</p>
          <p className="meta-value text-foreground">{job._id}</p>
        </div>
      </div>

      {/* Summary strip */}
      <div className="mt-8 grid gap-px border bg-border md:grid-cols-4">
        <Cell label="Status">
          <span
            className={cn(
              "px-1.5 py-0.5 text-[10px] font-semibold tracking-widest",
              STATUS_CLASSES[job.status as JobStatus],
            )}
          >
            {job.status}
          </span>
        </Cell>
        <Cell label="Current stage">
          <span className="meta-value text-foreground">
            {job.currentStage ? PIPELINE_STAGE_LABELS[job.currentStage] : "—"}
          </span>
        </Cell>
        <Cell label="Elapsed">
          <Elapsed since={job.startedAt ?? job.createdAt} />
        </Cell>
        <Cell label="Progress">
          <span className="meta-value text-base font-semibold tabular-nums">
            {job.progress}%
          </span>
        </Cell>
      </div>

      {/* Progress bar */}
      <div className="mt-px border bg-card p-4">
        <div className="h-3 w-full border bg-secondary">
          <div
            className={cn(
              "h-full transition-all duration-500",
              failed
                ? "bg-[var(--trace-red)]"
                : job.status === "DEGRADED"
                  ? "bg-[var(--trace-red)]/70"
                  : "bg-foreground",
            )}
            style={{ width: `${job.progress}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between">
          <span className="meta-label">{job.progress}% complete</span>
          <span className="meta-label">{DEMO_NOTICE}</span>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
        {/* Pipeline */}
        <section className="border bg-card p-6">
          <h2 className="text-sm font-semibold tracking-tight">
            Pipeline stages
          </h2>
          <div className="mt-5">
            <PipelineStepper
              currentStage={job.currentStage}
              status={job.status}
            />
          </div>
          {failed && (
            <div className="mt-6 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] p-4">
              <p className="meta-label flex items-center gap-1.5 text-[var(--trace-red)]">
                <XCircle className="size-3.5" /> Job failed
              </p>
              <p className="meta-value mt-2 leading-5 text-foreground/90">
                {job.errorMessage ?? "Unknown error."}
              </p>
              <div className="mt-4 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void retry({ jobId: job._id })}>
                  Retry job
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/analysis/new">Start new analysis</Link>
                </Button>
              </div>
            </div>
          )}
          {job.warnings.length > 0 && !failed && (
            <div className="mt-6">
              <WarningList warnings={job.warnings} />
            </div>
          )}
        </section>

        {/* Media info */}
        <aside className="space-y-px border bg-border">
          <VideoCell
            label="Source video"
            filename={job.sourceVideo?.filename}
            duration={job.sourceVideo?.durationSeconds}
            hasAudio={job.sourceVideo?.hasAudio}
          />
          <VideoCell
            label="Edited video"
            filename={job.editedVideo?.filename}
            duration={job.editedVideo?.durationSeconds}
            hasAudio={job.editedVideo?.hasAudio}
          />
          <div className="bg-card p-4">
            <p className="meta-label">Created</p>
            <p className="meta-value mt-1 text-foreground">
              {formatDateTime(job.createdAt)}
            </p>
            <p className="meta-label mt-3">Pipeline</p>
            <p className="meta-value mt-1 break-all text-muted-foreground">
              {job.pipelineVersion}
            </p>
          </div>
          {!failed && (
            <p className="bg-card p-4 meta-value leading-5 text-muted-foreground">
              Processing runs in the background — you can leave this page and
              reopen it from the dashboard at any time.
            </p>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-4">
      <p className="meta-label">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function VideoCell({
  label,
  filename,
  duration,
  hasAudio,
}: {
  label: string;
  filename?: string | null;
  duration?: number | null;
  hasAudio?: boolean | null;
}) {
  return (
    <div className="bg-card p-4">
      <p className="meta-label">{label}</p>
      <p className="meta-value mt-1 truncate text-foreground" title={filename ?? ""}>
        {filename ?? "—"}
      </p>
      <div className="mt-1 flex gap-3">
        <span className="meta-label">
          dur <span className="text-foreground">{duration ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}` : "—"}</span>
        </span>
        <span className="meta-label">
          audio{" "}
          <span className={cn(hasAudio ? "text-foreground" : "text-[var(--trace-red)]")}>
            {hasAudio ? "yes" : "no"}
          </span>
        </span>
      </div>
    </div>
  );
}
