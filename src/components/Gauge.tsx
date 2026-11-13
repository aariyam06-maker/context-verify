import { cn } from "@/lib/utils";

/** Semi-circular percentage gauge. `tone` picks the colour: red = AI / tampered, blue = authentic / original. */
export function Gauge({ value, label, tone, size = 180 }: { value: number; label: string; tone: "red" | "blue" | "muted"; size?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const r = 70, c = Math.PI * r;
  const colour = tone === "red" ? "var(--trace-red)" : tone === "blue" ? "var(--trace-blue)" : "var(--muted-foreground)";
  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 180 100" width={size} height={size * 0.56} role="img" aria-label={`${label}: ${v.toFixed(0)}%`}>
        <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="var(--border)" strokeWidth="14" />
        <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke={colour} strokeWidth="14" strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: "stroke-dasharray .8s ease" }} />
        <text x="90" y="82" textAnchor="middle" className="fill-foreground" style={{ fontSize: 30, fontWeight: 700 }}>{v.toFixed(0)}%</text>
      </svg>
      <p className={cn("meta-label mt-1 text-center")}>{label}</p>
    </div>
  );
}
