import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceEvent } from "@/components/FindingCard";
import type { TranscriptRow } from "@/components/EvidencePanel";
import { formatTimestamp, formatDuration } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Link2, Link2Off } from "lucide-react";

export type TimelineMapping = {
  _id: string;
  sourceIndex: number;
  editedIndex: number;
  similarity: number;
  sourceSegment: TranscriptRow | null;
  editedSegment: TranscriptRow | null;
};

function seekTo(video: HTMLVideoElement | null, t: number) {
  if (!video) return;
  try {
    video.currentTime = Math.max(0, t);
    void video.play().catch(() => {
      /* autoplay may be blocked; seek alone is fine */
    });
  } catch {
    /* seek before metadata ready */
  }
}

export function DualTimeline({
  sourceUrl,
  editedUrl,
  events,
  mappings,
  selectedEvent,
  onSelectEvent,
}: {
  sourceUrl: string | null;
  editedUrl: string | null;
  events: EvidenceEvent[];
  mappings: TimelineMapping[];
  selectedEvent: EvidenceEvent | null;
  onSelectEvent: (e: EvidenceEvent) => void;
}) {
  const sourceRef = useRef<HTMLVideoElement>(null);
  const editedRef = useRef<HTMLVideoElement>(null);
  const [srcTime, setSrcTime] = useState(0);
  const [editTime, setEditTime] = useState(0);
  const [srcDur, setSrcDur] = useState(0);
  const [editDur, setEditDur] = useState(0);
  const [linked, setLinked] = useState(true);
  const [playing, setPlaying] = useState(false);

  // Linear proportional linking between the two timelines.
  const linkFactor = srcDur > 0 && editDur > 0 ? editDur / srcDur : 1;

  const seekBoth = useCallback(
    (sourceTime: number) => {
      seekTo(sourceRef.current, sourceTime);
      if (linked && editDur > 0 && srcDur > 0) {
        seekTo(editedRef.current, Math.min(sourceTime * linkFactor, editDur));
      }
    },
    [linked, editDur, srcDur, linkFactor],
  );

  // Keep the two players synchronized while playing when linked.
  useEffect(() => {
    if (!linked) return;
    const onSrcTime = () => {
      const v = sourceRef.current;
      if (!v) return;
      setSrcTime(v.currentTime);
      if (playing && editedRef.current && editDur > 0 && srcDur > 0) {
        const target = v.currentTime * linkFactor;
        if (Math.abs(editedRef.current.currentTime - target) > 0.35) {
          editedRef.current.currentTime = Math.max(0, Math.min(target, editDur - 0.05));
        }
      }
    };
    const v = sourceRef.current;
    if (!v) return;
    v.addEventListener("timeupdate", onSrcTime);
    return () => v.removeEventListener("timeupdate", onSrcTime);
  }, [linked, playing, editDur, srcDur, linkFactor]);

  // Seek both players when a finding is selected (SRS core requirement).
  useEffect(() => {
    if (!selectedEvent) return;
    const t = selectedEvent.sourceStart ?? 0;
    seekBoth(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvent?._id]);

  const track = (
    duration: number,
    currentTime: number,
    side: "source" | "edited",
  ) => {
    const pct = (t: number) =>
      duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0;
    return (
      <div
        role="slider"
        aria-label={`${side} timeline`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const t = frac * duration;
          if (side === "source") seekBoth(t);
          else seekTo(editedRef.current, t);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            if (side === "source") seekBoth(currentTime + 1);
            else seekTo(editedRef.current, currentTime + 1);
          }
          if (e.key === "ArrowLeft") {
            if (side === "source") seekBoth(currentTime - 1);
            else seekTo(editedRef.current, currentTime - 1);
          }
        }}
        className="relative h-10 w-full cursor-crosshair border bg-secondary select-none"
      >
        {/* progress fill */}
        <div
          className="absolute inset-y-0 left-0 bg-foreground/8"
          style={{ width: `${pct(currentTime)}%` }}
        />
        {/* playhead */}
        <div
          className="absolute inset-y-0 w-0.5 bg-foreground"
          style={{ left: `${pct(currentTime)}%` }}
        />
        {/* aligned intervals (blue) */}
        {mappings
          .filter((m) => {
            const seg = side === "source" ? m.sourceSegment : m.editedSegment;
            return seg !== null;
          })
          .map((m) => {
            const seg = (side === "source" ? m.sourceSegment : m.editedSegment)!;
            return (
              <div
                key={m._id}
                title={`aligned (similarity ${(m.similarity * 100).toFixed(0)}%)`}
                className="absolute top-0 h-1.5 bg-[var(--trace-blue)]/50"
                style={{
                  left: `${pct(seg.startTime)}%`,
                  width: `${Math.max(0.4, pct(seg.endTime) - pct(seg.startTime))}%`,
                }}
              />
            );
          })}
        {/* event markers (red) */}
        {events
          .map((ev) => {
            const start = side === "source" ? ev.sourceStart : ev.editedStart;
            const end = side === "source" ? ev.sourceEnd : ev.editedEnd;
            if (start === null || start === undefined) return null;
            const endVal = end ?? start + 1;
            return (
              <button
                key={`${side}-${ev._id}`}
                type="button"
                title={`${ev.category} · ${formatTimestamp(start)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEvent(ev);
                }}
                className={cn(
                  "absolute bottom-1 h-3 min-w-[6px] border border-background transition-transform hover:scale-y-110",
                  ev.severity === "high" && "bg-[var(--trace-red)]",
                  ev.severity === "medium" &&
                    "bg-[var(--trace-red)]/70",
                  ev.severity === "low" && "bg-muted-foreground",
                )}
                style={{
                  left: `${pct(start)}%`,
                  width: `${Math.max(0.7, pct(endVal) - pct(start))}%`,
                }}
              />
            );
          })}
      </div>
    );
  };

  return (
    <section className="border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-secondary px-4 py-2.5">
        <h3 className="text-sm font-semibold tracking-tight">
          Synchronized timeline
        </h3>
        <button
          type="button"
          onClick={() => setLinked((v) => !v)}
          className="meta-label inline-flex items-center gap-1.5 border px-2 py-1 hover:bg-background"
          aria-pressed={linked}
        >
          {linked ? (
            <Link2 className="size-3.5 text-[var(--trace-blue)]" />
          ) : (
            <Link2Off className="size-3.5" />
          )}
          {linked ? "Linked seek" : "Independent seek"}
        </button>
      </header>

      <div className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        {(
          [
            { label: "SOURCE", ref: sourceRef, url: sourceUrl, time: srcTime, dur: srcDur, setDur: setSrcDur, side: "source" as const },
            { label: "EDITED", ref: editedRef, url: editedUrl, time: editTime, dur: editDur, setDur: setEditDur, side: "edited" as const },
          ] as const
        ).map((cfg) => (
          <div key={cfg.label} className="p-4">
            <div className="flex items-center justify-between">
              <span className="meta-label font-semibold text-foreground">
                {cfg.label}
              </span>
              <span className="meta-value text-muted-foreground">
                {formatTimestamp(cfg.time)} / {formatDuration(cfg.dur)}
              </span>
            </div>
            <div className="mt-2 aspect-video w-full border bg-black">
              {cfg.url ? (
                <video
                  ref={cfg.ref}
                  src={cfg.url}
                  controls
                  playsInline
                  className="size-full"
                  onLoadedMetadata={(e) => {
                    cfg.setDur(e.currentTarget.duration || 0);
                  }}
                  onTimeUpdate={(e) => {
                    if (cfg.side === "source") setSrcTime(e.currentTarget.currentTime);
                    else setEditTime(e.currentTarget.currentTime);
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
              ) : (
                <div className="flex size-full items-center justify-center text-center">
                  <p className="meta-label px-4 text-muted-foreground">
                    Video file not available in this browser session.
                  </p>
                </div>
                )}
            </div>
            <div className="mt-2">{track(cfg.dur, cfg.time, cfg.side)}</div>
          </div>
        ))}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-secondary/60 px-4 py-2">
        <span className="meta-label inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-4 bg-[var(--trace-blue)]/50" />
          aligned intervals
        </span>
        <span className="meta-label inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-1.5 bg-[var(--trace-red)]" />
          event markers
        </span>
        <span className="meta-label ml-auto">
          Click a marker or finding to seek both players
        </span>
      </footer>
    </section>
  );
}
