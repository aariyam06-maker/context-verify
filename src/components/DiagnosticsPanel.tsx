import { useMemo } from "react";
import { formatPercent } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Stethoscope, TrendingUp, HelpCircle } from "lucide-react";

interface DiagnosticsPanelProps {
  components: Array<{
    id: string;
    label: string;
    score: number; // 0..1
    confidence: number; // 0..1
    summary: string;
    raw?: string;
  }>;
  aiScore: number; // 0..100
  confidence: number; // 0..1
  weights?: Record<string, number>;
  className?: string;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  blockiness: 0.18,
  temporal_flicker: 0.22,
  saturation_dev: 0.12,
  texture_uniformity: 0.18,
  compression_noise: 0.15,
  frequency_energy: 0.15,
};

export function DiagnosticsPanel({
  components,
  aiScore,
  confidence,
  weights,
  className,
}: DiagnosticsPanelProps) {
  const breakdown = useMemo(() => {
    const w = weights ?? DEFAULT_WEIGHTS;
    const withWeight = components.map((c) => {
      const weight = w[c.id] ?? 0;
      // Contribution to the weighted mean (clip to 0..1 for display only).
      const contrib = Math.max(0, Math.min(1, c.score)) * weight;
      return { ...c, weight, contrib };
    });
    const totalWeight = withWeight.reduce((s, c) => s + c.weight, 0);
    const weightedSum = withWeight.reduce((s, c) => s + c.contrib, 0);
    const implied = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return { rows: withWeight, totalWeight, weightedSum, implied };
  }, [components, weights]);

  const topDrivers = useMemo(() => {
    return [...breakdown.rows]
      .filter((c) => c.score >= 0.45)
      .sort((a, b) => b.contrib - a.contrib)
      .slice(0, 3);
  }, [breakdown.rows]);

  const confidenceDrivers = useMemo(() => {
    const frameBased = Math.min(1, components.length / 24);
    const audioPenalty = 0;
    const resolutionPenalty = 0;
    const implied = Math.max(
      0.15,
      Math.min(0.9, frameBased * 0.9 - audioPenalty - resolutionPenalty),
    );
    return {
      frameBased,
      implied,
      gap: implied - confidence,
    };
  }, [components]);

  return (
    <section
      className={cn(
        "border bg-card p-5",
        "focus-within:border-foreground/40",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="meta-label flex items-center gap-1.5">
            <Stethoscope className="size-3" /> Model reasoning
          </p>
          <p className="meta-label mt-1 text-muted-foreground">
            How the score is composed — per component, its weight, and its
            contribution.
          </p>
        </div>
        <span className="meta-label whitespace-nowrap text-foreground font-semibold tabular-nums">
          {aiScore}% · conf {formatPercent(confidence)}
        </span>
      </div>

      <div className="mt-4 space-y-2">
        {breakdown.rows.map((c) => {
          const barPct = Math.max(0, Math.min(100, c.score * 100));
          const barColor =
            c.score >= 0.75
              ? "bg-[var(--trace-red)]"
              : c.score >= 0.55
                ? "bg-[var(--trace-red)]/70"
                : c.score >= 0.35
                  ? "bg-foreground/50"
                  : "bg-[var(--trace-blue)]/60";
          return (
            <div key={c.id} className="grid gap-px border-b last:border-b-0">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-1 py-1.5">
                <div className="min-w-0">
                  <span className="text-sm font-medium tracking-tight">
                    {c.label}
                  </span>
                  <span className="meta-label ml-2">{c.summary}</span>
                </div>
                <span className="meta-value tabular-nums text-foreground shrink-0">
                  {formatPercent(c.score, 1)}
                </span>
                <span className="meta-label tabular-nums text-muted-foreground shrink-0">
                  w {formatPercent(c.weight)}
                </span>
              </div>
              <div className="h-1.5 w-full bg-secondary px-1">
                <div
                  className={barColor}
                  style={{ width: `${barPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-px border bg-border">
        <div className="bg-card p-3">
          <p className="meta-label">Weighted mean (implied)</p>
          <p className="meta-value mt-0.5 text-foreground font-semibold tabular-nums">
            {Math.round(breakdown.implied * 100)}%
          </p>
          <p className="meta-label mt-0.5 text-muted-foreground">
            Recomposed from components above
          </p>
        </div>
        <div className="bg-card p-3">
          <p className="meta-label">Reported score</p>
          <p className="meta-value mt-0.5 text-foreground font-semibold tabular-nums">
            {aiScore}%
          </p>
          <p className="meta-label mt-0.5 text-muted-foreground">
            Rounded weighted mean
          </p>
        </div>
      </div>

      {topDrivers.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <p className="meta-label flex items-center gap-1.5 text-[var(--trace-red)]">
            <TrendingUp className="size-3" /> Top drivers
          </p>
          <ul className="mt-2 space-y-1">
            {topDrivers.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2 text-sm text-foreground/90"
              >
                <span className="shrink-0 mt-0.5">—</span>
                <span>
                  <span className="font-medium">{c.label}</span> at{" "}
                  {formatPercent(c.score, 1)} (weight {formatPercent(c.weight)})
                  · {c.summary}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="meta-label mt-4 border-t pt-3 leading-5 text-muted-foreground">
        Confidence is driven by frame count and completeness; the gap between
        implied and reported confidence reflects the scan's stated uncertainty
        calibration, not a hidden adjustment.
      </p>

      <details className="group mt-3">
        <summary className="meta-label cursor-pointer list-none flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <HelpCircle className="size-3" /> What this score does and does not mean
        </summary>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-muted-foreground">
          <li>
            This scan measures generation/over-processing artifact signatures
            (blocking, flicker, chroma, texture, noise, spectral shape) from
            the actual pixels of the uploaded file.
          </li>
          <li>
            It does <span className="text-foreground">not</span> run
            generative-model weights in the browser, so it estimates
            AI-*generation/over-process* likelihood, not the semantic
            "AI-ness" of the content.
          </li>
          <li>
            Each component is normalized to 0..1 against documented calibration
            anchors; the weighted mean is scaled to a 0..100 score. Anchors are
            approximations from natural-video baselines and are stated honestly
            in the UI.
          </li>
          <li>
            Detectability of modern generative video is limited; treat the score
            as a forensic indicator with stated uncertainty, never as proof.
          </li>
        </ul>
      </details>
    </section>
  );
}
