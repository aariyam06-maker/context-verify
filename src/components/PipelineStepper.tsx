import { PIPELINE_STAGE_LABELS, PIPELINE_STAGE_ORDER } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Check, AlertTriangle } from "lucide-react";

export function PipelineStepper({
  currentStage,
  status,
}: {
  currentStage?: string | null;
  status: string;
}) {
  const activeIdx = PIPELINE_STAGE_ORDER.indexOf(currentStage ?? "");
  const done = status === "COMPLETED" || status === "DEGRADED";
  const failed = status === "FAILED";

  return (
    <ol className="space-y-0">
      {PIPELINE_STAGE_ORDER.map((stage, idx) => {
        const isDone = done || (idx < activeIdx && !failed);
        const isCurrent = !done && !failed && idx === activeIdx;
        const isPending = !isDone && !isCurrent && !failed;
        return (
          <li key={stage} className="relative flex gap-4 pb-6 last:pb-0">
            {/* rail */}
            {idx < PIPELINE_STAGE_ORDER.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[11px] top-6 h-full w-px",
                  isDone ? "bg-foreground" : "bg-border",
                )}
              />
            )}
            {/* node */}
            <span
              className={cn(
                "relative z-10 flex size-6 shrink-0 items-center justify-center border",
                isDone && "bg-foreground text-background border-foreground",
                isCurrent && "border-foreground bg-background",
                isPending && "border-border bg-background",
                failed && "border-[var(--trace-red)] bg-background",
              )}
            >
              {isDone && <Check className="size-3.5" strokeWidth={3} />}
              {isCurrent && <span className="size-2 animate-pulse bg-[var(--trace-red)]" />}
              {failed && idx === activeIdx && (
                <AlertTriangle className="size-3.5 text-[var(--trace-red)]" />
              )}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-medium tracking-tight",
                  isDone && "text-foreground",
                  isCurrent && "text-foreground",
                  isPending && "text-muted-foreground",
                  failed && idx === activeIdx && "text-[var(--trace-red)]",
                )}
              >
                {PIPELINE_STAGE_LABELS[stage]}
              </p>
              {isCurrent && (
                <p className="meta-label mt-0.5 text-[var(--trace-red)]">
                  processing…
                </p>
              )}
            </div>
            {isDone && (
              <span className="meta-label ml-auto self-start text-muted-foreground/70">
                ✓
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="border border-[var(--trace-red)]/30 bg-[var(--trace-red-soft)] p-4">
      <p className="meta-label flex items-center gap-1.5 text-[var(--trace-red)]">
        <AlertTriangle className="size-3.5" />
        Warnings ({warnings.length})
      </p>
      <ul className="mt-2 space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className="meta-value leading-5 text-foreground/80">
            — {w}
          </li>
        ))}
      </ul>
    </div>
  );
}
