import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type TimelinePoint = { t: number; frameProb: number; blended: number };

/** Per-frame AI probability across the analysed timeline. */
export function AiTimeline({ data, height = 180, intervals = [] }: { data: TimelinePoint[]; height?: number; intervals?: Array<{ start: number; end: number }> }) {
  if (!data?.length) return null;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="aiFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--trace-red)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--trace-red)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tickFormatter={(v) => `${Number(v).toFixed(1)}s`} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} stroke="var(--border)" />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} stroke="var(--border)" />
          <ReferenceLine y={50} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
          {intervals.map((interval, i) => <ReferenceArea key={i} x1={interval.start} x2={interval.end} ifOverflow="extendDomain" fill="var(--trace-red)" fillOpacity={0.15} />)}
          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", fontSize: 12 }} formatter={(v: number, n: string) => [`${v.toFixed(0)}%`, n === "blended" ? "AI likelihood" : "Frame model"]} labelFormatter={(v) => `t = ${Number(v).toFixed(2)} s`} />
          <Area type="monotone" dataKey="blended" stroke="var(--trace-red)" strokeWidth={2} fill="url(#aiFill)" isAnimationActive />
          <Area type="monotone" dataKey="frameProb" stroke="var(--trace-blue)" strokeWidth={1} strokeDasharray="3 3" fill="none" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
