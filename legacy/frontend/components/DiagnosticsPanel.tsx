import { formatPercent } from "@/lib/trace";

type Diagnostic = { id: string; label: string; score: number; confidence: number; summary: string };

export function DiagnosticsPanel({ components, aiScore, confidence }: { components: Diagnostic[]; aiScore: number; confidence: number }) {
  return (
    <details className="py-2">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Detector diagnostics</summary>
      <div className="mt-3 grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {components.map((component) => (
          <div key={component.id} className="bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold">{component.label}</span>
              <span className="text-xs tabular-nums">{formatPercent(component.score)}</span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{component.summary}</p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">confidence {formatPercent(component.confidence)}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Video score: {aiScore}% · analysis confidence: {formatPercent(confidence)}.</p>
    </details>
  );
}
