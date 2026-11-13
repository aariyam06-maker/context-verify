import { CATEGORY_CLASSES, formatTimestamp, formatPercent } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

export type EvidenceEvent = {
  _id: string;
  category: string;
  severity: string;
  confidence: number;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  editedStart?: number | null;
  editedEnd?: number | null;
  observedChange: string;
  evidenceType: string;
};

export function FindingCard({
  event,
  selected,
  onSelect,
  index,
}: {
  event: EvidenceEvent;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group w-full border bg-card p-4 text-left transition-all hover:border-foreground/40",
        selected && "border-[var(--trace-red)] red-marker",
        !selected && "border-border",
      )}
      aria-pressed={selected}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="meta-value text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span
            className={cn(
              "px-1.5 py-0.5 text-[11px] font-semibold tracking-tight",
              CATEGORY_CLASSES[event.category] ??
                "bg-muted text-foreground border border-border",
            )}
          >
            {event.category}
          </span>
          <span
            className={cn(
              "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest",
              event.severity === "high" && "bg-[var(--trace-red)] text-white",
              event.severity === "medium" &&
                "bg-[var(--trace-red-soft)] text-[var(--trace-red)]",
              event.severity === "low" && "bg-muted text-muted-foreground",
            )}
          >
            {event.severity}
          </span>
        </div>
        <ChevronRight
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5",
            selected && "text-[var(--trace-red)]",
          )}
        />
      </div>

      <p className="meta-value mt-3 text-foreground/90">
        {event.observedChange}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2">
        <span className="meta-label">
          SRC{" "}
          <span className="text-foreground">
            {formatTimestamp(event.sourceStart)}–{formatTimestamp(event.sourceEnd)}
          </span>
        </span>
        <span className="meta-label">
          EDIT{" "}
          <span className="text-foreground">
            {formatTimestamp(event.editedStart)}–{formatTimestamp(event.editedEnd)}
          </span>
        </span>
        <span className="meta-label">
          CONF{" "}
          <span className="text-foreground">
            {formatPercent(event.confidence)}
          </span>
        </span>
        <span className="meta-label ml-auto hidden sm:inline">
          {event.evidenceType.replace(/_/g, " ")}
        </span>
      </div>
    </button>
  );
}
