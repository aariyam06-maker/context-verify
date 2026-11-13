import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertTriangle, CheckCircle2, Download, Loader2, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { AiTimeline } from "@/components/AiTimeline";
import { Gauge } from "@/components/Gauge";
import { Button } from "@/components/ui/button";
import { api, useJobPolling, type JobSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const STAGES: Record<string, string> = {
  queued: "Queued",
  loading_models: "Loading models",
  frame_sampling_and_features: "Sampling frames · extracting CLIP + forensic features",
  ai_analysis_and_alignment: "AI analysis of both videos · frame alignment",
  report_generation: "Writing report",
  done: "Done",
};

const isTerminal = (j: JobSummary) => j.status === "COMPLETED" || j.status === "FAILED";

export default function Result() {
  const { jobId } = useParams();
  const loader = useCallback((id: string) => api.jobs.get(id), []);
  const { data: job, error } = useJobPolling(jobId, loader, isTerminal);
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    if (job?.status === "COMPLETED" && jobId && !report) void api.jobs.report(jobId).then(setReport).catch(() => undefined);
  }, [job?.status, jobId, report]);

  const download = async (format: "pdf" | "json") => {
    if (!jobId) return;
    const blob = await api.jobs.reportDownload(jobId, format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `contexttrace-${jobId}.${format}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <AppShell>
      {error && !job && <p className="text-[var(--trace-red)]">{error.message}</p>}
      {!job && !error && <p className="text-muted-foreground">Loading…</p>}
      {job && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="meta-label">{job.mode === "detect" ? "AI-generated video detection" : "Evidence tamper check"} · job {job._id.slice(0, 8)}</p>
              <h1 className="display-lg mt-2 text-3xl">{job.mode === "detect" ? job.videoA : `${job.videoA}  ⇄  ${job.videoB}`}</h1>
            </div>
            {report && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => download("pdf")}><Download className="size-4" />PDF report</Button>
                <Button variant="outline" onClick={() => download("json")}><Download className="size-4" />JSON</Button>
              </div>
            )}
          </div>
          {!isTerminal(job) && <Progress job={job} />}
          {job.status === "FAILED" && (
            <div className="mt-8 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] p-5">
              <p className="font-semibold text-[var(--trace-red)]">Analysis failed</p>
              <p className="mt-1 text-sm">{job.errorMessage}</p>
            </div>
          )}
          {report && job.mode === "detect" && <DetectView r={report.result} videoId={job.videoAId} />}
          {report && job.mode === "tamper" && <TamperView r={report.result} job={job} />}
        </>
      )}
    </AppShell>
  );
}

function Progress({ job }: { job: JobSummary }) {
  return (
    <div className="mt-10 border bg-card p-8">
      <div className="flex items-center gap-3"><Loader2 className="size-5 animate-spin" /><p className="font-semibold">{STAGES[job.currentStage ?? "queued"] ?? job.currentStage}</p></div>
      <div className="mt-5 h-2 w-full bg-secondary"><div className="h-2 bg-foreground transition-all duration-700" style={{ width: `${Math.max(4, job.progress)}%` }} /></div>
      <p className="meta-label mt-3">Typical runtime on a laptop CPU: 10–25 s per video (first run also loads the models).</p>
    </div>
  );
}

function useStream(id: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let u: string | null = null;
    void api.videos.stream(id).then((x) => { u = x; setUrl(x); }).catch(() => undefined);
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url;
}

function Verdict({ ai, label, sub }: { ai: boolean; label: string; sub: string }) {
  return (
    <div className={cn("flex items-start gap-4 border p-5", ai ? "border-[var(--trace-red)]/50 bg-[var(--trace-red-soft)]" : "border-[var(--trace-blue)]/50 bg-[var(--trace-blue-soft)]")}>
      {ai ? <ShieldAlert className="size-8 shrink-0 text-[var(--trace-red)]" /> : <ShieldCheck className="size-8 shrink-0 text-[var(--trace-blue)]" />}
      <div><p className="text-2xl font-bold tracking-tight">{label}</p><p className="mt-1 text-sm text-muted-foreground">{sub}</p></div>
    </div>
  );
}

function Evidence({ items }: { items: any[] }) {
  if (!items?.length) return null;
  return (
    <div className="border">
      <div className="border-b bg-secondary px-4 py-2.5"><p className="meta-label">Strongest forensic signals</p></div>
      <div className="divide-y">
        {items.map((e) => (
          <div key={e.key} className="grid gap-1 px-4 py-3 md:grid-cols-[1fr_auto]">
            <div><p className="text-sm font-semibold">{e.title}</p><p className="text-xs text-muted-foreground">{e.description}</p></div>
            <p className={cn("meta-label self-center", e.pushesTowards === "AI" ? "text-[var(--trace-red)]" : "text-[var(--trace-blue)]")}>→ {e.pushesTowards === "AI" ? "AI-like" : "camera-like"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetectView({ r, videoId, compact }: { r: any; videoId?: string | null; compact?: boolean }) {
  const url = useStream(compact ? null : videoId);
  const ai = r.verdict === "ai_generated";
  return (
    <div className={cn("space-y-6", !compact && "mt-8")}>
      <Verdict ai={ai} label={r.verdictLabel} sub={`${r.confidenceBand} confidence · ${r.media.framesAnalysed} frames analysed over ${r.media.analysedSeconds}s · ${r.media.width}×${r.media.height}`} />
      <div className={cn("grid gap-6", !compact && "lg:grid-cols-[1fr_1.2fr]")}>
        <div className="flex flex-wrap items-center justify-around gap-4 border bg-card p-6">
          <Gauge value={r.aiProbability} label="AI-generation probability" tone={ai ? "red" : "blue"} />
          <Gauge value={r.aiContentShare} label="AI content share of timeline" tone={r.aiContentShare >= 50 ? "red" : "blue"} />
        </div>
        {!compact && url && <video src={url} controls className="aspect-video w-full border bg-black object-contain" />}
      </div>
      <div className="border bg-card p-5">
        <p className="meta-label mb-2">AI likelihood over time <span className="ml-2 text-[var(--trace-red)]">— blended</span><span className="ml-2 text-[var(--trace-blue)]">- - frame model</span></p>
        <AiTimeline data={r.timeline} />
        <div className="mt-3 flex flex-wrap gap-2">
          {r.segments?.map((s: any, i: number) => (
            <span key={i} className={cn("meta-label border px-2 py-1", s.label === "ai" ? "border-[var(--trace-red)]/50 text-[var(--trace-red)]" : "text-[var(--trace-blue)]")}>{s.start.toFixed(1)}–{s.end.toFixed(1)}s · {s.label === "ai" ? "AI-like" : "camera-like"}</span>
          ))}
        </div>
      </div>
      <Evidence items={r.evidence} />
      {r.gemini && (
        <div className="border bg-card p-4 text-sm">
          <p className="meta-label inline-flex items-center gap-1.5"><Sparkles className="size-3" />Gemini second opinion ({r.gemini.model})</p>
          {r.gemini.probability != null ? <p className="mt-1">{(r.gemini.probability * 100).toFixed(0)}% AI — {r.gemini.reasons?.join("; ")}</p> : <p className="mt-1 text-muted-foreground">Unavailable: {r.gemini.error}</p>}
        </div>
      )}
      {!compact && (
        <p className="meta-label">Model {r.model.version} · {r.model.classifier} on {r.model.features} · analysis {r.timing.total}s · probabilities are calibrated estimates, not legal proof</p>
      )}
    </div>
  );
}

function TamperView({ r, job }: { r: any; job: JobSummary }) {
  const urlA = useStream(job.videoAId);
  const urlB = useStream(job.videoBId);
  const refs = { a: useRef<HTMLVideoElement>(null), b: useRef<HTMLVideoElement>(null) };
  const tampered = r.tampered as "a" | "b" | null;
  const original = r.original as "a" | "b" | null;
  const region = r.events?.find((e: any) => e.type === "in_frame_edit")?.bbox;
  const seek = (side: "a" | "b", t?: number) => { const v = refs[side].current; if (v && t != null) { v.currentTime = t; void v.play(); } };
  const headline = r.verdict === "tampered" ? `${r.videos[original!].name} is the ORIGINAL · ${r.videos[tampered!].name} was TAMPERED`
    : r.verdict === "no_tampering" ? "No tampering detected — both videos carry identical footage" : "Videos are unrelated — no shared footage";

  return (
    <div className="mt-8 space-y-6">
      <div className={cn("flex items-start gap-4 border p-5", r.verdict === "tampered" ? "border-[var(--trace-red)]/50 bg-[var(--trace-red-soft)]" : "border-[var(--trace-blue)]/50 bg-[var(--trace-blue-soft)]")}>
        {r.verdict === "tampered" ? <AlertTriangle className="size-8 shrink-0 text-[var(--trace-red)]" /> : <CheckCircle2 className="size-8 shrink-0 text-[var(--trace-blue)]" />}
        <div>
          <p className="text-2xl font-bold tracking-tight">{headline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{r.summary}</p>
          <p className="meta-label mt-2">decision confidence {(r.confidence * 100).toFixed(0)}% · shared footage A→B {r.coverage.aInB}% · B→A {r.coverage.bInA}%</p>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {(["a", "b"] as const).map((k) => {
          const v = r.videos[k];
          const role = original === k ? "ORIGINAL" : tampered === k ? "TAMPERED" : r.verdict === "no_tampering" ? "IDENTICAL" : "—";
          return (
            <div key={k} className="border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <p className="meta-value truncate">{k.toUpperCase()} · {v.name}</p>
                <span className={cn("px-2 py-0.5 text-[10px] font-bold tracking-widest", role === "TAMPERED" ? "bg-[var(--trace-red)] text-white" : role === "ORIGINAL" ? "bg-[var(--trace-blue)] text-white" : "bg-secondary")}>{role}</span>
              </div>
              <div className="relative">
                {(k === "a" ? urlA : urlB) ? <video ref={refs[k]} src={(k === "a" ? urlA : urlB)!} controls muted className="aspect-video w-full bg-black object-contain" /> : <div className="aspect-video w-full bg-black" />}
                {region && tampered === k && (
                  <div className="pointer-events-none absolute border-2 border-[var(--trace-red)]" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }} title="edited region" />
                )}
              </div>
              <div className="flex flex-wrap justify-around gap-2 p-4">
                <Gauge size={140} value={v.originality ?? 100 - v.ai.aiProbability} label={v.originality != null ? "Originality" : "Authenticity"} tone={(v.originality ?? 100 - v.ai.aiProbability) >= 50 ? "blue" : "red"} />
                <Gauge size={140} value={v.ai.aiProbability} label="AI-generated" tone={v.ai.aiProbability >= 50 ? "red" : "blue"} />
                <Gauge size={140} value={v.ai.aiContentShare} label="AI content share" tone={v.ai.aiContentShare >= 50 ? "red" : "blue"} />
              </div>
              <div className="border-t px-4 py-3"><AiTimeline data={v.ai.timeline} height={110} /></div>
            </div>
          );
        })}
      </div>
      {r.events?.length > 0 && (
        <div className="border">
          <div className="border-b bg-secondary px-4 py-2.5"><p className="meta-label">Located tampering evidence ({r.events.length})</p></div>
          <div className="divide-y">
            {r.events.map((e: any, i: number) => {
              const side = e.in === "tampered" ? tampered : original;
              return (
                <button key={i} type="button" onClick={() => side && seek(side, e.start)} className="grid w-full gap-1 px-4 py-3 text-left hover:bg-secondary md:grid-cols-[180px_1fr_auto]">
                  <span className={cn("text-sm font-semibold", e.severity === "high" ? "text-[var(--trace-red)]" : "")}>{e.title}</span>
                  <span className="text-sm text-muted-foreground">{e.description}</span>
                  <span className="meta-label self-center">{e.start != null ? `${e.in} @ ${Number(e.start).toFixed(1)}s ▶` : e.in}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <p className="meta-label">Direction model {r.model.version} ({r.model.classifier}) · cross-validated accuracy {(r.model.cvAccuracy * 100).toFixed(1)}% · analysis {r.timing.total}s · <Link to="/history" className="underline">history</Link></p>
    </div>
  );
}
