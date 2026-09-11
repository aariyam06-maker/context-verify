import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/AppShell";
import { ScoreCard } from "@/components/ScoreCard";
import { FindingCard } from "@/components/FindingCard";
import { EvidencePanel } from "@/components/EvidencePanel";
import { DualTimeline } from "@/components/DualTimeline";
import { WarningList } from "@/components/PipelineStepper";
import { formatDateTime, formatBytes, formatDuration } from "@/lib/trace";
import { Loader2 } from "lucide-react";
import { Link, useParams } from "react-router";
import type { Id } from "@/convex/_generated/dataModel";
import { getVideo } from "@/lib/local-videos";

export default function AnalysisReport() {
  const { jobId } = useParams<{ jobId: string }>();
  const id = jobId as Id<"analysisJobs"> | undefined;

  const job = useQuery(api.jobs.getJob, id ? { jobId: id } : "skip");
  const report = useQuery(api.jobs.getReport, id ? { jobId: id } : "skip");
  const events = useQuery(api.jobs.getEvidence, id ? { jobId: id } : "skip");
  const detail = useQuery(api.jobs.getEvidenceDetail, id ? { jobId: id } : "skip");

  // Local artifact URLs (IndexedDB) for the synchronized timeline.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [editedUrl, setEditedUrl] = useState<string | null>(null);
  const srcKey = job?.sourceVideo?.storageKey ?? null;
  const editKey = job?.editedVideo?.storageKey ?? null;

  useEffect(() => {
    let revoked = false;
    const created: string[] = [];
    async function load() {
      if (srcKey) {
        const f = await getVideo(srcKey);
        if (f && !revoked) {
          const u = URL.createObjectURL(f);
          created.push(u);
          setSourceUrl(u);
        }
      }
      if (editKey) {
        const f = await getVideo(editKey);
        if (f && !revoked) {
          const u = URL.createObjectURL(f);
          created.push(u);
          setEditedUrl(u);
        }
      }
    }
    void load();
    return () => {
      revoked = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [srcKey, editKey]);

  // Effective selection: explicit user choice, else the first finding.
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);
  const selectedId =
    userSelectedId && (events ?? []).some((e) => e._id === userSelectedId)
      ? userSelectedId
      : ((events ?? [])[0]?._id ?? null);

  const selectedEvent = useMemo(
    // The evidence detail shape is a superset of FindingCard's EvidenceEvent.
    () => (events ?? []).find((e) => e._id === selectedId) ?? null,
    [events, selectedId],
  );

  if (job === undefined) {
    return (
      <AppShell>
        <Loading />
      </AppShell>
    );
  }
  if (job === null) {
    return (
      <AppShell>
        <NotFound404 />
      </AppShell>
    );
  }

  // Still processing → route to the live progress view.
  if (job.status === "QUEUED" || job.status === "RUNNING") {
    return (
      <AppShell>
        <div className="py-24 text-center">
          <p className="meta-label">Analysis still processing</p>
          <h1 className="display-lg mt-2 text-3xl">Report not ready</h1>
          <Button asChild className="mt-6">
            <Link to={`/analysis/${jobId}/progress`}>View live progress</Link>
          </Button>
        </div>
      </AppShell>
    );
  }

  if (job.status === "FAILED") {
    return (
      <AppShell>
        <div className="py-24 text-center">
          <p className="meta-label text-[var(--trace-red)]">Analysis failed</p>
          <h1 className="display-lg mt-2 text-3xl">No report available</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            {job.errorMessage ??
              "A critical pipeline stage failed; no misleading report was generated."}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link to={`/analysis/${jobId}/progress`}>View job details</Link>
            </Button>
            <Button asChild>
              <Link to="/analysis/new">Start new analysis</Link>
            </Button>
  </div>
        </div>
      </AppShell>
    );
  }

  const eligible = report != null && events != null && detail != null;

  return (
    <AppShell>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Analysis report</p>
          <h1 className="display-lg mt-2 text-4xl">
            {job.sourceVideo?.filename ?? "Source"}{" "}
            <span className="text-muted-foreground/50">vs.</span>{" "}
            {job.editedVideo?.filename ?? "Edit"}
          </h1>
        </div>
        <div className="text-right">
          <p className="meta-label">Completed</p>
          <p className="meta-value text-foreground">
            {job.completedAt ? formatDateTime(job.completedAt) : "—"}
          </p>
        </div>
      </div>

      {job.warnings.length > 0 && (
        <div className="mt-6">
          <WarningList warnings={job.warnings} />
        </div>
      )}

      {eligible ? (
        <>
          <div className="mt-6">
            <ScoreCard
              score={report.score}
              overallConfidence={report.overallConfidence}
              evidenceCoverage={report.evidenceCoverage}
              uncertainty={report.uncertainty}
              interpretation={report.interpretation}
              degraded={report.degraded}
              pipelineVersion={report.pipelineVersion}
              modelConfiguration={report.modelConfiguration}
            />
          </div>

          {/* Findings + evidence detail */}
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(320px,2fr)_3fr]">
            <section>
              <h2 className="text-sm font-semibold tracking-tight">
                Findings
                <span className="meta-label ml-2">
                  {events.length} detected · sorted by severity
                </span>
              </h2>
              <div className="mt-4 space-y-px border bg-border">
                {events.length === 0 ? (
                  <div className="bg-card p-8 text-center">
                    <p className="meta-label">No material findings</p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Speech alignment found no structural differences clearing
                      the evidence thresholds. This is not a guarantee of
                      authenticity — see coverage and uncertainty in the summary.
                    </p>
                  </div>
                ) : (
                  events.map((ev, i) => (
                    <FindingCard
                      key={ev._id}
                      event={ev}
                      index={i}
                      selected={ev._id === selectedId}
                      onSelect={() => setUserSelectedId(ev._id)}
                    />
                  ))
                )}
              </div>
            </section>

            <section>
              {selectedEvent ? (
                <EvidencePanel
                  event={selectedEvent}
                  sourceTranscript={detail.sourceTranscript}
                  editedTranscript={detail.editedTranscript}
                />
              ) : (
                <div className="border bg-card p-10 text-center">
                  <p className="meta-label">Select a finding</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Evidence detail appears here with transcript excerpts on
                    both sides.
                  </p>
                </div>
              )}
            </section>
          </div>

          {/* Synchronized timeline */}
          <div className="mt-8">
            <DualTimeline
              sourceUrl={sourceUrl}
              editedUrl={editedUrl}
              events={events}
              mappings={detail.mappings}
              selectedEvent={selectedEvent}
              onSelectEvent={(e) => setUserSelectedId(e._id)}
            />
          </div>

          {/* Technical metadata */}
          <section className="mt-8 border bg-card p-6">
            <h2 className="text-sm font-semibold tracking-tight">
              Technical metadata
            </h2>
            <div className="mt-4 grid gap-x-8 md:grid-cols-2">
              <MetaRow label="Job ID" value={job._id} />
              <MetaRow
                label="Report generated"
                value={report ? formatDateTime(report.createdAt) : "—"}
              />
              <MetaRow
                label="Source"
                value={
                  job.sourceVideo
                    ? `${job.sourceVideo.filename} · ${formatBytes(job.sourceVideo.byteSize)} · ${formatDuration(job.sourceVideo.durationSeconds)}`
                    : "—"
                }
              />
              <MetaRow
                label="Edited"
                value={
                  job.editedVideo
                    ? `${job.editedVideo.filename} · ${formatBytes(job.editedVideo.byteSize)} · ${formatDuration(job.editedVideo.durationSeconds)}`
                    : "—"
                }
              />
              <MetaRow label="Pipeline" value={report?.pipelineVersion ?? "—"} />
              <MetaRow
                label="Model configuration"
                value={report?.modelConfiguration ?? "—"}
              />
            </div>
            <p className="meta-label mt-6 border-t pt-4 leading-5">
              ContextTrace identifies evidence consistent with contextual
              manipulation; it does not establish intent directly. Scores
              summarize structural edit evidence, not truthfulness.
            </p>
          </section>
        </>
      ) : (
        <div className="mt-6 border bg-card p-10 text-center">
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          <p className="meta-label mt-3">Assembling report…</p>
        </div>
      )}
    </AppShell>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b py-1.5 last:border-b-0">
      <span className="meta-label w-40 shrink-0">{label}</span>
      <span className="meta-value break-all text-foreground/90">{value}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-3 py-24">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <span className="meta-label">Loading report…</span>
    </div>
  );
}

function NotFound404() {
  return (
    <div className="py-24 text-center">
      <p className="meta-label text-[var(--trace-red)]">404</p>
      <h1 className="display-lg mt-2 text-3xl">Analysis not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This analysis does not exist or belongs to another account.
      </p>
      <Button asChild className="mt-6">
        <Link to="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
