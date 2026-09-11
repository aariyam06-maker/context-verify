import { useMemo } from "react";
import { DEMO_NOTICE, formatTimestamp, formatPercent } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { CircleAlert, MoveRight } from "lucide-react";

export type EvidenceEventFull = {
  _id: string;
  category: string;
  severity: string;
  confidence: number;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  editedStart?: number | null;
  editedEnd?: number | null;
  observedChange: string;
  contextualImpact: string;
  explanation: string;
  evidenceType: string;
};

export type TranscriptRow = {
  _id: string;
  startTime: number;
  endTime: number;
  text: string;
  confidence: number;
};

export function EvidencePanel({
  event,
  sourceTranscript,
  editedTranscript,
}: {
  event: EvidenceEventFull;
  sourceTranscript: TranscriptRow[];
  editedTranscript: TranscriptRow[];
}) {
  // Segments overlapping the event window on each side. Events store segment
  // indices on the backend, but the panel re-derives overlap from timestamps —
  // robust whether or not segment ids resolved at persistence time.
  const relevant = useMemo(() => {
    const pick = (
      rows: TranscriptRow[],
      start?: number | null,
      end?: number | null,
    ) => {
      if (start === null || start === undefined) return [];
      const endVal = end ?? start + 1;
      return rows.filter(
        (r) => r.startTime < endVal + 0.5 && r.endTime > start - 0.5,
      );
    };
    return {
      source: pick(sourceTranscript, event.sourceStart, event.sourceEnd),
      edited: pick(editedTranscript, event.editedStart, event.editedEnd),
    };
  }, [event, sourceTranscript, editedTranscript]);

  return (
    <div className="border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-secondary px-4 py-2.5">
        <span className="meta-label">Evidence detail · {event.category}</span>
        <span className="meta-label">
          {event.evidenceType.replace(/_/g, " ")} · conf{" "}
          {formatPercent(event.confidence)}
        </span>
      </div>

      {/* Two-column evidence: SOURCE vs EDITED */}
      <div className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        <EvidenceColumn
          label="SOURCE"
          rows={relevant.source}
          windowStart={event.sourceStart}
          windowEnd={event.sourceEnd}
          emptyText="No source transcript in this window. For omissions this is expected: the statement exists only in the source column above."
        />
        <EvidenceColumn
          label="EDITED"
          rows={relevant.edited}
          windowStart={event.editedStart}
          windowEnd={event.editedEnd}
          emptyText="No edited transcript in this window. For omissions the edited side has no counterpart; for splices the inserted material sits here."
        />
      </div>

      {/* OBSERVED CHANGE vs CONTEXTUAL IMPACT — deliberately separated */}
      <div className="grid grid-cols-1 divide-y border-t md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="p-4">
          <p className="meta-label flex items-center gap-1.5 text-foreground">
            <CircleAlert className="size-3.5 text-[var(--trace-red)]" />
            Observed change
          </p>
          <p className="mt-2 text-sm leading-6 text-foreground/90">
            {event.observedChange}
          </p>
          <p className="meta-value mt-3 leading-5 text-muted-foreground">
            {event.explanation}
          </p>
        </div>
        <div className="p-4">
          <p className="meta-label flex items-center gap-1.5 text-foreground">
            <MoveRight className="size-3.5 text-[var(--trace-blue)]" />
            Contextual impact — assessment
          </p>
          <p className="mt-2 text-sm leading-6 text-foreground/90">
            {event.contextualImpact}
          </p>
          <p className="meta-value mt-3 leading-5 text-muted-foreground">
            ContextTrace surfaces evidence; reviewers decide intent.
          </p>
        </div>
      </div>

      <p className="border-t bg-secondary/60 px-4 py-2 meta-value text-muted-foreground">
        {DEMO_NOTICE}
      </p>
    </div>
  );
}

function EvidenceColumn({
  label,
  rows,
  windowStart,
  windowEnd,
  emptyText,
}: {
  label: string;
  rows: TranscriptRow[];
  windowStart?: number | null;
  windowEnd?: number | null;
  emptyText: string;
}) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between">
        <span className="meta-label font-semibold text-foreground">{label}</span>
        <span className="meta-value text-muted-foreground">
          {formatTimestamp(windowStart)}–{formatTimestamp(windowEnd)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="meta-value mt-3 leading-5 text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((r) => (
            <li key={r._id} className="flex gap-3">
              <span
                className={cn(
                  "meta-value shrink-0 pt-0.5",
                  r.confidence < 0.7 && "text-[var(--trace-red)]",
                )}
              >
                {formatTimestamp(r.startTime)}
              </span>
              <p className="text-sm leading-6 text-foreground/90">
                {r.text}
                <span className="meta-label ml-2 whitespace-nowrap">
                  conf {formatPercent(r.confidence)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
