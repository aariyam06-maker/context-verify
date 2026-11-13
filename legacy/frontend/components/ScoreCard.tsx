import { DEMO_NOTICE, formatPercent, scoreBand } from "@/lib/trace";
import { cn } from "@/lib/utils";

export function ScoreCard({
  score,
  overallConfidence,
  evidenceCoverage,
  uncertainty,
  interpretation,
  degraded,
  pipelineVersion,
  modelConfiguration,
}: {
  score: number;
  overallConfidence: number;
  evidenceCoverage: number;
  uncertainty: number;
  interpretation: string;
  degraded: boolean;
  pipelineVersion: string;
  modelConfiguration: string;
}) {
  const band = scoreBand(score);
  return (
    <section className="border bg-card">
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr]">
        {/* Score block */}
        <div className="border-b p-6 md:border-b-0 md:border-r">
          <p className="meta-label">Context Integrity Score</p>
          <div className="mt-2 flex items-end gap-3">
            <span
              className={cn(
                "display-xl text-7xl font-bold leading-none tracking-tight",
                band.className,
              )}
            >
              {score}
            </span>
            <span className="meta-label pb-2">/ 100</span>
          </div>
          <p className={cn("meta-label mt-3", band.className)}>
            {band.label}
          </p>
          <div className="mt-4 h-2 w-full border">
            <div
              className={cn(
                "h-full",
                score >= 85
                  ? "bg-[var(--trace-blue)]"
                  : score >= 45
                    ? "bg-[var(--trace-red)]/70"
                    : "bg-[var(--trace-red)]",
              )}
              style={{ width: `${score}%` }}
            />
          </div>
          {degraded && (
            <p className="meta-label mt-4 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-2 py-1 text-[var(--trace-red)]">
              DEGRADED — partial evidence
            </p>
          )}
        </div>

        {/* Interpretation + meta grid */}
        <div className="p-6">
          <p className="meta-label">Interpretation</p>
          <p className="mt-2 max-w-prose text-base leading-7 text-foreground/90">
            {interpretation}
          </p>
          <div className="mt-5 grid grid-cols-3 gap-px border bg-border">
            <MetaCell label="Overall confidence" value={formatPercent(overallConfidence)} />
            <MetaCell label="Evidence coverage" value={formatPercent(evidenceCoverage)} />
            <MetaCell label="Uncertainty" value={formatPercent(uncertainty)} />
          </div>
          <div className="mt-4 space-y-1">
            <p className="meta-value text-muted-foreground">
              pipeline: {pipelineVersion}
            </p>
            <p className="meta-value break-all text-muted-foreground">
              config: {modelConfiguration}
            </p>
          </div>
        </div>
      </div>
      <p className="border-t bg-secondary/60 px-4 py-2 meta-value text-muted-foreground">
        {DEMO_NOTICE}
      </p>
    </section>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-3">
      <p className="meta-label">{label}</p>
      <p className="meta-value mt-1 text-base font-semibold text-foreground">
        {value}
      </p>
    </div>
  );
}
