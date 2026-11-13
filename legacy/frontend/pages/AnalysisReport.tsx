import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, useApiQuery } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { FindingCard } from "@/components/FindingCard";
import { EvidencePanel, type EvidenceEventFull, type TranscriptRow } from "@/components/EvidencePanel";
import { DualTimeline, type TimelineMapping } from "@/components/DualTimeline";
import { Button } from "@/components/ui/button";
import { formatPercent, formatDuration, DEMO_NOTICE } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { BookmarkCheck, FileVideo, ShieldAlert, Video, Download } from "lucide-react";

export default function AnalysisReport() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const jobLoader = useMemo(() => () => api.jobs.get(jobId!), [jobId]);
  const reportLoader = useMemo(() => () => api.jobs.report(jobId!), [jobId]);
  const evidenceLoader = useMemo(() => () => api.jobs.evidence(jobId!), [jobId]);
  const { data: job, error: jobError } = useApiQuery(jobLoader, [jobLoader]);
  const { data: report } = useApiQuery(reportLoader, [reportLoader]);
  const { data: evidence } = useApiQuery(evidenceLoader, [evidenceLoader]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [editedUrl, setEditedUrl] = useState<string | null>(null);

  const selected = useMemo(() => {
    const events = (report?.findings ?? []) as EvidenceEventFull[];
    return events.find((e) => e._id === selectedId) ?? events[0] ?? null;
  }, [report, selectedId]);

  useEffect(() => {
    if (!job?.sourceVideo?.storageKey) return;
    let active = true;
    void api.videos.stream(job.sourceVideo.storageKey).then((url) => { if (active) setSourceUrl(url); else URL.revokeObjectURL(url); }).catch(() => undefined);
    return () => { active = false; if (sourceUrl) URL.revokeObjectURL(sourceUrl); };
    // source URL is intentionally not a dependency: it would retrigger after assignment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.sourceVideo?.storageKey]);

  useEffect(() => {
    if (!job?.editedVideo?.storageKey) return;
    let active = true;
    void api.videos.stream(job.editedVideo.storageKey).then((url) => { if (active) setEditedUrl(url); else URL.revokeObjectURL(url); }).catch(() => undefined);
    return () => { active = false; if (editedUrl) URL.revokeObjectURL(editedUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.editedVideo?.storageKey]);

  if (jobError) return <AppShell><div className="py-24 text-center"><p className="meta-label text-[var(--trace-red)]">Report unavailable</p><p className="mt-2 text-sm text-muted-foreground">{jobError.message}</p><Button className="mt-5" asChild><Link to="/history">Back to history</Link></Button></div></AppShell>;
  if (!job) return <AppShell><div className="py-24 text-center"><p className="meta-label">Loading report…</p></div></AppShell>;

  const findings = (report?.findings ?? []) as EvidenceEventFull[];
  const sourceTranscript = (evidence?.sourceTranscript ?? []) as TranscriptRow[];
  const editedTranscript = (evidence?.editedTranscript ?? []) as TranscriptRow[];
  const mappings = (evidence?.mappings ?? []) as TimelineMapping[];

  return <AppShell>
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="meta-label">Analysis Report · {job.status}</p><h1 className="display-lg mt-2 text-3xl">{job.sourceFilename} <span className="text-muted-foreground">vs.</span> {job.editedFilename}</h1></div><nav className="flex gap-2"><Button variant="outline" size="sm" onClick={async () => { const blob = await api.jobs.reportDownload(job.id, "pdf"); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `contexttrace-report-${job.id}.pdf`; a.click(); URL.revokeObjectURL(url); }}><Download className="size-4" /> PDF</Button><Button variant="outline" size="sm" asChild><Link to="/history"><BookmarkCheck className="size-4" /> History</Link></Button></nav></div>

    <div className="mt-6 grid gap-px border bg-border md:grid-cols-4">
      <Meta label="Context Integrity Score" value={report ? `${report.score}%` : "—"} strong />
      <Meta label="Overall confidence" value={report ? formatPercent(report.overallConfidence) : "—"} />
      <Meta label="Evidence coverage" value={report ? formatPercent(report.evidenceCoverage) : "—"} />
      <Meta label="Uncertainty" value={report ? formatPercent(report.uncertainty) : "—"} />
    </div>

    {report && <section className="mt-6 border bg-card p-6"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 size-4 text-[var(--trace-blue)]" /><div><p className="meta-label">Interpretation</p><p className="mt-2 max-w-4xl text-sm leading-6">{report.interpretation}</p><p className="meta-label mt-4 text-muted-foreground">{DEMO_NOTICE}</p></div></div></section>}

    <div className="mt-6 grid gap-6 lg:grid-cols-2"><VideoMeta label="SOURCE VIDEO" video={job.sourceVideo} icon={<Video className="size-4" />} /><VideoMeta label="EDITED VIDEO" video={job.editedVideo} icon={<FileVideo className="size-4" />} /></div>

    {sourceUrl && editedUrl && <div className="mt-6"><DualTimeline sourceUrl={sourceUrl} editedUrl={editedUrl} events={findings as any} mappings={mappings} selectedEvent={selected as any} onSelectEvent={(event) => setSelectedId(event._id)} /></div>}

    {(report?.visualEvidence?.length > 0 || report?.sourceOcr?.length > 0 || report?.editedOcr?.length > 0) && <section className="mt-6 border bg-card p-6"><p className="meta-label">Supporting multimodal evidence</p><div className="mt-4 grid gap-4 lg:grid-cols-3"><EvidenceMini title="Visual correspondence" rows={(report.visualEvidence ?? []).slice(0, 12).map((v: any) => `${Number(v.editedTime).toFixed(1)}s edit → ${Number(v.sourceTime).toFixed(1)}s source · ${(Number(v.similarity) * 100).toFixed(0)}%`)}/><EvidenceMini title="Source OCR" rows={(report.sourceOcr ?? []).slice(0, 12).map((v: any) => `${Number(v.timestamp).toFixed(1)}s · ${v.text}`)}/><EvidenceMini title="Edited OCR" rows={(report.editedOcr ?? []).slice(0, 12).map((v: any) => `${Number(v.timestamp).toFixed(1)}s · ${v.text}`)}/></div></section>}

    <section className="mt-6"><div className="flex items-end justify-between"><div><p className="meta-label">Event-level evidence</p><h2 className="mt-1 text-xl font-bold">Findings</h2></div><span className="meta-label">{findings.length} event{findings.length === 1 ? "" : "s"}</span></div>{findings.length === 0 ? <div className="mt-4 border bg-secondary/40 p-10 text-center"><p className="meta-label">No candidate edit events</p><p className="mt-2 text-sm text-muted-foreground">No supported omission, reordering, splice, discontinuity or caption/speech mismatch was detected.</p></div> : <div className="mt-4 grid gap-3 lg:grid-cols-2">{findings.map((event, i) => <FindingCard key={event._id} event={event as any} index={i} selected={selected?._id === event._id} onSelect={() => setSelectedId(event._id)} />)}</div>}</section>

    {selected && <section className="mt-6"><EvidencePanel event={selected} sourceTranscript={sourceTranscript} editedTranscript={editedTranscript} /></section>}

    <section className="mt-6 border bg-secondary/40 p-4"><p className="meta-label">Reproducibility</p><p className="mt-2 text-sm text-muted-foreground">Pipeline {report?.pipelineVersion ?? job.pipelineVersion} · {report?.modelConfiguration ?? job.modelConfiguration}</p><p className="mt-1 text-xs text-muted-foreground">The report separates observed edit events from contextual-impact assessment. Missing modalities are recorded as uncertainty rather than treated as positive evidence.</p></section>
  </AppShell>;
}

function EvidenceMini({ title, rows }: { title: string; rows: string[] }) { return <div className="border bg-secondary/40 p-3"><p className="meta-label font-semibold">{title}</p>{rows.length ? <ul className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">{rows.map((row, i) => <li key={i}>{row}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No observations recorded.</p>}</div>; }
function Meta({ label, value, strong }: { label: string; value: string; strong?: boolean }) { return <div className="bg-card p-4"><p className="meta-label">{label}</p><p className={cn("mt-1 text-2xl tabular-nums", strong && "font-bold")}>{value}</p></div>; }
function VideoMeta({ label, video, icon }: { label: string; video: any; icon: React.ReactNode }) { return <div className="border bg-card p-4"><p className="meta-label font-semibold">{label}</p>{video ? <div className="mt-2 flex items-center gap-3"><span className="text-muted-foreground">{icon}</span><span className="truncate text-sm font-medium">{video.filename}</span><span className="meta-label ml-auto">{formatDuration(video.durationSeconds)}</span></div> : <p className="mt-2 text-sm text-muted-foreground">No media record.</p>}</div>; }
