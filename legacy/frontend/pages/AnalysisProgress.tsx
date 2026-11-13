import { useEffect, useMemo, useState } from "react";
import { api, useJobPolling } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PipelineStepper, WarningList } from "@/components/PipelineStepper";
import { PIPELINE_STAGE_LABELS, STATUS_CLASSES, DEMO_NOTICE, type JobStatus } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useParams } from "react-router";

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  if (!since) return <span className="meta-value">0:00</span>;
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="meta-value tabular-nums">{Math.floor(total / 60)}:{String(total % 60).padStart(2, "0")}</span>;
}

export default function AnalysisProgress() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const loader = useMemo(() => (id: string) => api.jobs.get(id), []);
  const terminal = useMemo(() => (job: any) => ["COMPLETED", "DEGRADED", "FAILED"].includes(job?.status), []);
  const { data: job, error } = useJobPolling(jobId, loader, terminal);

  useEffect(() => {
    if (job && (job.status === "COMPLETED" || job.status === "DEGRADED")) {
      const t = window.setTimeout(() => navigate(`/analysis/${jobId}`, { replace: true }), 500);
      return () => window.clearTimeout(t);
    }
  }, [job, jobId, navigate]);

  if (error) return <AppShell><div className="py-24 text-center"><p className="meta-label text-[var(--trace-red)]">Unable to load job</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button className="mt-5" asChild><Link to="/dashboard">Back to dashboard</Link></Button></div></AppShell>;
  if (!job) return <AppShell><div className="flex items-center gap-3 py-24"><Loader2 className="size-5 animate-spin text-muted-foreground" /><span className="meta-label">Loading job…</span></div></AppShell>;

  const failed = job.status === "FAILED";
  return <AppShell>
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="meta-label">Step 2 of 2 · Processing</p><h1 className="display-lg mt-2 text-4xl">Analysis Progress</h1></div><div className="text-right"><p className="meta-label">Job ID</p><p className="meta-value text-foreground">{job._id}</p></div></div>
    <div className="mt-8 grid gap-px border bg-border md:grid-cols-4">
      <Cell label="Status"><span className={cn("px-1.5 py-0.5 text-[10px] font-semibold tracking-widest", STATUS_CLASSES[job.status as JobStatus])}>{job.status}</span></Cell>
      <Cell label="Current stage"><span className="meta-value text-foreground">{job.currentStage ? PIPELINE_STAGE_LABELS[job.currentStage] ?? job.currentStage : "—"}</span></Cell>
      <Cell label="Elapsed"><Elapsed since={job.startedAt ?? job.createdAt} /></Cell>
      <Cell label="Progress"><span className="meta-value text-base font-semibold tabular-nums">{job.progress}%</span></Cell>
    </div>
    <div className="mt-px border bg-card p-4"><div className="h-3 w-full border bg-secondary"><div className={cn("h-full transition-all duration-500", failed ? "bg-[var(--trace-red)]" : job.status === "DEGRADED" ? "bg-[var(--trace-red)]/70" : "bg-foreground")} style={{ width: `${job.progress}%` }} /></div><div className="mt-2 flex justify-between"><span className="meta-label">{job.progress}% complete</span><span className="meta-label">{DEMO_NOTICE}</span></div></div>
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
      <section className="border bg-card p-6"><h2 className="text-sm font-semibold tracking-tight">Pipeline stages</h2><div className="mt-5"><PipelineStepper currentStage={job.currentStage} status={job.status} /></div>{failed && <div className="mt-6 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] p-4"><p className="meta-label flex items-center gap-1.5 text-[var(--trace-red)]"><XCircle className="size-3.5" /> Job failed</p><p className="meta-value mt-2 leading-5 text-foreground/90">{job.errorMessage ?? "Unknown error."}</p><div className="mt-4 flex gap-2"><Button size="sm" variant="outline" onClick={() => void api.jobs.retry(job._id).then(() => window.location.reload())}>Retry job</Button><Button size="sm" variant="ghost" asChild><Link to="/analysis/new">Start new analysis</Link></Button></div></div>}{job.warnings?.length > 0 && !failed && <div className="mt-6"><WarningList warnings={job.warnings} /></div>}</section>
      <aside className="border bg-secondary/50 p-6"><p className="meta-label">What happens now</p><ol className="mt-4 space-y-3 text-sm leading-5 text-muted-foreground"><li>01 · Validate and normalize both media files.</li><li>02 · Generate timestamped speech evidence.</li><li>03 · Align speech, inspect visual correspondence and OCR.</li><li>04 · Detect omissions, reordering, splices and discontinuities.</li><li>05 · Assess contextual impact and assemble a traceable report.</li></ol></aside>
    </div>
  </AppShell>;
}
function Cell({ label, children }: { label: string; children: React.ReactNode }) { return <div className="bg-card p-3"><p className="meta-label">{label}</p><div className="mt-1">{children}</div></div>; }
