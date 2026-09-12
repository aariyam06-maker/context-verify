import { useMemo } from "react";
import { CTXTRACE_MODEL } from "@/model/ctxtrace-model.generated";
import { formatPercent } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { Stethoscope, HelpCircle, ShieldAlert } from "lucide-react";

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
  className?: string;
}

// Weights reflect feature importance in the standardized logistic/ML model
// (relative magnitude of the learned coefficients, normalized to a readable
// 0..1 display). They are calibration explanations, not a second classifier.
const MODEL_WEIGHTS: Record<string, number> = {
  blockiness: 0.14,
  temporal_flicker: 0.20,
  saturation_dev: 0.10,
  texture_uniformity: 0.16,
  compression_noise: 0.14,
  frequency_energy: 0.14,
  glcm_contrast: 0.06,
  edge_coherence: 0.04,
  chroma_aberration: 0.04,
  ringing: 0.08,
};

const MODEL_VERSION = CTXTRACE_MODEL.version;

type ComponentRow = DiagnosticsPanelProps["components"][0] & { weight: number; contrib: number };

function weightedNeighbors(components: DiagnosticsPanelProps["components"]): {
  rows: ComponentRow[];
  totalWeight: number;
  weightedSum: number;
  implied: number;
} {
  const rows: ComponentRow[] = components.map((c) => {
    const w = MODEL_WEIGHTS[c.id] ?? 0;
    const contrib = Math.max(0, Math.min(1, c.score)) * w;
    return { ...c, weight: w, contrib };
  });
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const weightedSum = rows.reduce((s, r) => s + r.contrib, 0);
  const implied = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { rows, totalWeight, weightedSum, implied };
}

function topDrivers(rows: ComponentRow[]) {
  return [...rows]
    .filter((c) => c.score >= 0.45)
    .sort((a, b) => b.contrib - a.contrib)
    .slice(0, 3);
}

function confidenceReadout(
  components: DiagnosticsPanelProps["components"],
  declared: number,
) {
  const frameBased = Math.min(1, components.length / 24);
  const implied = Math.max(0.15, Math.min(0.9, frameBased * 0.9));
  return {
    frameBased,
    implied,
    gap: implied - declared,
    lowFrameCount: components.length < 12,
  };
}

export function DiagnosticsPanel({
  components,
  aiScore,
  confidence,
  className,
}: DiagnosticsPanelProps) {
  const breakdown = useMemo(() => weightedNeighbors(components), [components]);
  const drivers = useMemo(() => topDrivers(breakdown.rows), [breakdown.rows]);
  const readout = useMemo(
    () => confidenceReadout(components, confidence),
    [components, confidence],
  );

  return (
    <section
      className={cn("border bg-card p-5", "focus-within:border-foreground/40", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="meta-label flex items-center gap-1.5">
            <Stethoscope className="size-3" /> Model reasoning
          </p>
          <p className="meta-label mt-1 text-muted-foreground">
            How the score is composed — per component, its model weight, and its
            contribution to the weighted mean.
          </p>
        </div>
        <span className="meta-label whitespace-nowrap text-foreground font-semibold tabular-nums">
          {aiScore}% · conf {formatPercent(confidence)}
        </span>
      </div>

      <p className="mt-3 flex items-start gap-2 text-muted-foreground text-sm">
        <HelpCircle className="size-3.5 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          Deterministic forensic scanner (browser-side frame analysis). Reads the
          uploaded pixels directly; it is not a generative-model classifier and does
          not prove origin. Model: <span className="text-foreground font-medium">{MODEL_VERSION}</span>.
          Weights are calibration explanations, not a second opinion.
        </span>
      </p>

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
                <div className={barColor} style={{ width: `${barPct}%` }} />
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
            Weighted average of component scores using model weights above.
          </p>
        </div>
        <div className="bg-card p-3">
          <p className="meta-label">Declared confidence</p>
          <p className="meta-value mt-0.5 text-foreground font-semibold tabular-nums">
            {formatPercent(confidence, 1)}
          </p>
          <p className="meta-label mt-0.5 text-muted-foreground">
            {readout.lowFrameCount
              ? "Lower confidence: few sampled frames."
              : "Frame-count and metadata based."}
          </p>
        </div>
      </div>

      {drivers.length > 0 && (
        <div className="mt-4 border-t bg-border/50 p-3">
          <p className="meta-label">Top drivers</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {drivers.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2 text-muted-foreground"
              >
                <span className="shrink-0 text-[var(--trace-red)] font-semibold tabular-nums">
                  {Math.round(c.contrib * 100)}%
                </span>
                <span className="text-foreground">
                  <strong className="font-medium">{c.label}</strong> —{" "}
                  {c.summary.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded border bg-amber-500/10 p-3 text-sm text-muted-foreground">
        <ShieldAlert className="size-3.5 mt-0.5 shrink-0 text-amber-500" />
        <span className="leading-relaxed">
          This readout explains the calculated score, not the video&apos;s provenance.
          Forensics supports review; it does not establish intent or identity.
        </span>
      </div>
    </section>
  );
}
