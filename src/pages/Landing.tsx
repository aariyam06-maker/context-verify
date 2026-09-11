import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  motion,
  MotionConfig,
  useScroll,
  useTransform,
  useSpring,
  animate,
  useInView,
  useMotionValue,
} from "framer-motion";
import {
  AudioLines,
  Layers,
  ScanSearch,
  ArrowRight,
  ArrowDown,
  ArrowUpRight,
  Info,
  ShieldCheck,
  Captions,
  Scissors,
  Quote,
  Fingerprint,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

const CAPABILITIES = [
  {
    icon: AudioLines,
    title: "Speech alignment",
    code: "01",
    body: "Timestamped transcription of both videos, then semantic correspondence matching. Every aligned, missing and reordered statement is traced to exact timecodes on both sides.",
    span: "lg:col-span-3 lg:row-span-2",
  },
  {
    icon: Captions,
    title: "OCR / caption evidence",
    code: "02",
    body: "On-screen text is extracted and cross-checked against the spoken track — mismatched captions are a classic miscontext signal.",
    span: "lg:col-span-3",
  },
  {
    icon: Layers,
    title: "Multimodal evidence",
    code: "03",
    body: "Speech is primary; visual correspondence and OCR contribute supporting evidence. No single modality stands alone as proof.",
    span: "lg:col-span-2",
  },
  {
    icon: ScanSearch,
    title: "Context impact assessment",
    code: "04",
    body: "Omissions, reordering and splices are assessed for whether they materially change the meaning a viewer receives.",
    span: "lg:col-span-2",
  },
  {
    icon: ShieldCheck,
    title: "Evidence, not verdicts",
    code: "05",
    body: "Confidence, coverage and uncertainty accompany every result. Scores are transparent and auditable.",
    span: "lg:col-span-2",
  },
];

const LIMITS = [
  {
    body: "ContextTrace identifies evidence consistent with contextual change. It does not establish intent, and it does not label ordinary editing as malicious.",
    tag: "INTENT",
  },
  {
    body: "A missing or non-contiguous mapping is a candidate edit event — never automatically misinformation or deception.",
    tag: "EVIDENCE",
  },
  {
    body: "Scores are transparent and evidence-backed, not a black-box verdict. Confidence, coverage and uncertainty accompany every result.",
    tag: "AUDIT",
  },
];

const SPECIMENS = [
  {
    kind: "OMISSION",
    sev: "HIGH",
    sevColor: "var(--trace-red)",
    quote: "…which is why we are pausing the rollout entirely.",
    note: "Full qualification dropped from the short cut",
    src: { tc: "00:12:41", dur: "14s" },
    edit: { tc: "00:03:12", dur: "2s" },
    sim: 0.94,
    bars: 22,
    hot: [4, 5, 6, 15, 16, 17],
  },
  {
    kind: "REORDER",
    sev: "MEDIUM",
    sevColor: "oklch(0.72 0.13 84)",
    quote: "Costs first, benefits later — the sequence is inverted",
    note: "Clause order reversed within one answer",
    src: { tc: "00:04:08", dur: "9s" },
    edit: { tc: "00:01:44", dur: "9s" },
    sim: 0.88,
    bars: 22,
    hot: [9, 10, 11],
  },
  {
    kind: "SPLICE",
    sev: "HIGH",
    sevColor: "var(--trace-red)",
    quote: "Two answers cut into a single statement",
    note: "Non-contiguous segments joined with no transition",
    src: { tc: "00:22:19", dur: "6s" },
    edit: { tc: "00:02:05", dur: "4s" },
    sim: 0.91,
    bars: 22,
    hot: [2, 3, 12, 13],
  },
  {
    kind: "CAPTION MISMATCH",
    sev: "MEDIUM",
    sevColor: "oklch(0.72 0.13 84)",
    quote: "“Temporary halt” rendered as “Permanent ban”",
    note: "Burned-in caption contradicts the spoken track",
    src: { tc: "00:09:57", dur: "3s" },
    edit: { tc: "00:01:02", dur: "3s" },
    sim: 0.83,
    bars: 22,
    hot: [7, 8, 9],
  },
  {
    kind: "ALIGNMENT",
    sev: "LOW",
    sevColor: "var(--trace-blue)",
    quote: "Faithful condensation — same meaning, shorter",
    note: "All claims preserved across the cut",
    src: { tc: "00:02:30", dur: "31s" },
    edit: { tc: "00:00:18", dur: "8s" },
    sim: 0.99,
    bars: 22,
    hot: [],
  },
  {
    kind: "DISCONTINUITY",
    sev: "LOW",
    sevColor: "var(--trace-blue)",
    quote: "Scene jump with no audio overlap",
    note: "Visual cut at 00:05:12, speech continuous",
    src: { tc: "00:05:12", dur: "2s" },
    edit: { tc: "00:04:41", dur: "1s" },
    sim: 0.96,
    bars: 22,
    hot: [19],
  },
];

const STAGES = [
  { n: "01", t: "Media validation & pre-processing", d: "Codec, duration and integrity checks on both inputs; representative frames are extracted for the visual channel." },
  { n: "02", t: "Timestamped speech transcription", d: "Each track is transcribed into segments with start, end, text and confidence — the substrate for every comparison." },
  { n: "03", t: "Semantic speech alignment", d: "Embeddings match source statements to their edited counterparts. This alignment is the primary correspondence signal." },
  { n: "04", t: "Representative-frame extraction", d: "Key frames are sampled at scene boundaries to give the visual channel something comparable to work with." },
  { n: "05", t: "Visual correspondence", d: "Frames from the edit are matched back to their source moments, exposing footage that came from nowhere else." },
  { n: "06", t: "OCR / caption extraction", d: "Burned-in text is read from frames and compared against the transcript — captions are a favourite miscontext vector." },
  { n: "07", t: "Edit-event detection", d: "Omissions, reordering, splices, discontinuities and caption mismatches are proposed as candidate events with bounds." },
  { n: "08", t: "Contextual-impact assessment", d: "Each candidate is weighed for whether it materially changes qualification, stance, chronology or emphasis." },
  { n: "09", t: "Evidence-backed report", d: "A score, per-finding evidence, timecode jumps and an overall confidence are assembled into the final report." },
];

const TICKER = [
  "OMISSION", "REORDER", "SPLICE", "CAPTION MISMATCH", "NON-CONTIGUOUS",
  "DISCONTINUITY", "ALIGNMENT", "CONFIDENCE", "COVERAGE", "TIMECODES",
];

/* ————— Small animated pieces ————— */

function useCountUp(target: number, decimals: number, started: boolean, duration = 1.6) {
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState("0");
  useEffect(() => {
    if (!started) return;
    const controls = animate(mv, target, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v.toFixed(decimals)),
    });
    return () => controls.stop();
  }, [started, target, decimals, duration, mv]);
  return display;
}

function Reveal({
  children,
  delay = 0,
  y = 28,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function SectionHead({
  label,
  title,
  className,
}: {
  label: React.ReactNode;
  title: React.ReactNode;
  className?: string;
}) {
  return (
    <Reveal className={className}>
      <p className="meta-label flex items-center gap-2">
        <span className="inline-block h-[3px] w-6 bg-[var(--trace-red)]" />
        {label}
      </p>
      <h2 className="display-lg mt-4 max-w-2xl">{title}</h2>
    </Reveal>
  );
}

function CountStat({
  value,
  decimals,
  suffix,
  label,
  sub,
}: {
  value: number;
  decimals: number;
  suffix?: string;
  label: string;
  sub: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const display = useCountUp(value, decimals, inView);
  return (
    <div ref={ref} className="border-l pl-4">
      <p className="font-display text-4xl font-bold tracking-tight tabular-nums md:text-5xl">
        {display}
        {suffix && <span className="text-[var(--trace-red)]">{suffix}</span>}
      </p>
      <p className="mt-1 text-sm font-semibold tracking-tight">{label}</p>
      <p className="meta-value mt-0.5 text-muted-foreground">{sub}</p>
    </div>
  );
}

function WordReveal({
  text,
  delay = 0,
  className,
}: {
  text: string;
  delay?: number;
  className?: string;
}) {
  const words = text.split(" ");
  return (
    <span className={className}>
      {words.map((w, i) => (
        <span key={i} className="inline-block overflow-hidden pb-[0.08em] -mb-[0.08em] align-bottom">
          <motion.span
            className="inline-block will-change-transform"
            initial={{ y: "110%" }}
            animate={{ y: "0%" }}
            transition={{ duration: 0.7, delay: delay + i * 0.055, ease: EASE }}
          >
            {w}
            {i < words.length - 1 ? "\u00A0" : ""}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

/* ————— Hero simulation: live comparison ————— */

const SCRIPT = [
  { side: "src" as const, tc: "00:12:41", text: "…which is why we are pausing the rollout until the independent audit completes." },
  { side: "edit" as const, tc: "00:03:12", text: "…which is why we are pausing the rollout." },
  { side: "note" as const, tc: "Δ 9.4s", text: "Qualification dropped — “until the independent audit completes” omitted." },
];

function SimRow({ row, index }: { row: (typeof SCRIPT)[number]; index: number }) {
  const isNote = row.side === "note";
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9 + index * 0.55, duration: 0.5, ease: EASE }}
      className={
        "flex items-start gap-3 border p-3 " +
        (isNote ? "border-[var(--trace-red)] bg-[var(--trace-red-soft)]" : "bg-background/80")
      }
    >
      <span
        className={
          "meta-value shrink-0 px-1 py-0.5 " +
          (row.side === "src" ? "bg-foreground text-background" : "bg-[var(--trace-blue)] text-white")
        }
      >
        {row.side === "src" ? "SOURCE" : row.side === "edit" ? "EDITED" : "FINDING"}
      </span>
      <div className="min-w-0">
        <p className={"meta-value " + (isNote ? "text-[var(--trace-red)]" : "text-muted-foreground")}>
          {row.tc}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug tracking-tight">{row.text}</p>
      </div>
    </motion.div>
  );
}

function HeroCompare() {
  const bars = 26;
  const hotBars = new Set([5, 6, 7, 16, 17]);
  return (
    <div className="ct-drift relative border bg-card shadow-[0_30px_80px_-30px_oklch(0.18_0.01_260/0.4)]">
      {/* window chrome */}
      <div className="flex items-center justify-between border-b bg-secondary px-4 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="size-2.5 bg-foreground/20" />
          <span className="size-2.5 bg-foreground/20" />
          <span className="size-2.5 bg-[var(--trace-red)]" />
        </div>
        <p className="meta-label">job #4721 · source vs. short-form</p>
        <p className="meta-value flex items-center gap-1.5 text-[var(--trace-red)]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping bg-[var(--trace-red)] opacity-60" />
            <span className="relative inline-flex size-1.5 bg-[var(--trace-red)]" />
          </span>
          LIVE
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border">
        {/* SOURCE panel */}
        <div className="bg-background p-4">
          <div className="flex items-center justify-between">
            <span className="meta-label font-semibold text-foreground">SOURCE</span>
            <span className="meta-value text-muted-foreground">14:58</span>
          </div>
          <div className="relative mt-2 aspect-video border bg-black">
            <div className="grid-paper absolute inset-0 opacity-40" style={{ backgroundSize: "16px 16px" }} />
            <div className="absolute inset-x-3 bottom-2 top-3 grid grid-cols-3 gap-1.5 opacity-70">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="border border-white/15 bg-white/[0.06]" />
              ))}
            </div>
            <div className="ct-scan-sweep" />
          </div>
          <div className="mt-2 h-6 border bg-secondary">
            <div className="h-full w-[86%] bg-foreground/10" />
          </div>
        </div>

        {/* EDITED panel */}
        <div className="bg-background p-4">
          <div className="flex items-center justify-between">
            <span className="meta-label font-semibold text-foreground">EDITED</span>
            <span className="meta-value text-muted-foreground">00:59</span>
          </div>
          <div className="relative mt-2 aspect-video border bg-black">
            <div className="grid-paper absolute inset-0 opacity-40" style={{ backgroundSize: "16px 16px" }} />
            <div className="absolute inset-x-3 bottom-2 top-3 grid grid-cols-3 gap-1.5 opacity-70">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className={i === 4 ? "border border-[var(--trace-red)]/60 bg-[var(--trace-red)]/20" : "border border-white/15 bg-white/[0.06]"} />
              ))}
            </div>
            <div className="ct-scan-sweep" style={{ animationDelay: "1.1s" }} />
          </div>
          <div className="mt-2 h-6 border bg-secondary">
            <div className="h-full w-[86%]">
              <div className="relative h-full">
                {[14, 52].map((left) => (
                  <motion.span
                    key={left}
                    className="absolute inset-y-0 w-[2px] bg-[var(--trace-red)]"
                    style={{ left: `${left}%` }}
                    initial={{ scaleY: 0.2, opacity: 0 }}
                    animate={{ scaleY: 1, opacity: 1 }}
                    transition={{ delay: 2.1, duration: 0.5, ease: EASE }}
                  />
                ))}
                <span className="absolute inset-y-0 left-[30%] w-[22%] bg-[var(--trace-red)]/25" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* alignment strip */}
      <div className="border-t px-4 pb-1 pt-3">
        <div className="flex items-end gap-[3px]" aria-hidden>
          {Array.from({ length: bars }).map((_, i) => (
            <motion.span
              key={i}
              className={
                "w-full " +
                (hotBars.has(i) ? "bg-[var(--trace-red)]" : "bg-foreground/25")
              }
              style={{ height: `${18 + ((i * 7) % 14)}px` }}
              initial={{ scaleY: 0.15, opacity: 0 }}
              animate={{ scaleY: 1, opacity: 1 }}
              transition={{ delay: 1.4 + i * 0.03, duration: 0.4, ease: EASE }}
            />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between">
          <span className="meta-label">source timeline</span>
          <span className="meta-label text-[var(--trace-red)]">2 gaps · 1 reorder</span>
        </div>
      </div>

      {/* transcript rows */}
      <div className="space-y-px border-t bg-border p-px">
        {SCRIPT.map((row, i) => (
          <SimRow key={i} row={row} index={i} />
        ))}
      </div>
    </div>
  );
}

/* ————— Specimen card (masonry) ————— */

function SpecimenCard({ s, index }: { s: (typeof SPECIMENS)[number]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const glowX = useSpring(useTransform(mx, [0, 1], ["25%", "75%"]), { stiffness: 220, damping: 26 });
  const glowY = useSpring(useTransform(my, [0, 1], ["15%", "85%"]), { stiffness: 220, damping: 26 });
  const tiltX = useSpring(useTransform(my, [0, 1], [2.5, -2.5]), { stiffness: 220, damping: 26 });
  const tiltY = useSpring(useTransform(mx, [0, 1], [-2.5, 2.5]), { stiffness: 220, damping: 26 });
  const glow = useTransform(
    [glowX, glowY],
    ([gx, gy]: string[]) =>
      `radial-gradient(220px circle at ${gx} ${gy}, var(--trace-red-soft), transparent 70%)`,
  );

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 26 }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.6, delay: (index % 3) * 0.08, ease: EASE }}
      style={{ rotateX: tiltX, rotateY: tiltY, transformPerspective: 900 }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        mx.set((e.clientX - r.left) / r.width);
        my.set((e.clientY - r.top) / r.height);
      }}
      onMouseLeave={() => {
        mx.set(0.5);
        my.set(0.5);
      }}
      className="ct-specimen group relative border bg-card p-5 [transform-style:preserve-3d]"
    >
      {/* cursor-follow sheen */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: glow }}
      />
      <div className="flex items-center justify-between">
        <span className="meta-value border px-1.5 py-0.5" style={{ color: s.sevColor, borderColor: s.sevColor }}>
          {s.kind}
        </span>
        <span className="meta-label">SEV {s.sev}</span>
      </div>

      <div className="mt-4 flex gap-2" aria-hidden>
        {Array.from({ length: s.bars }).map((_, i) => (
          <span
            key={i}
            className="h-4 w-1 origin-bottom"
            style={{
              background: s.hot.includes(i) ? s.sevColor : "var(--border)",
              transform: s.hot.includes(i) ? "scaleY(1.35)" : undefined,
              transition: "background .2s, transform .2s",
            }}
          />
        ))}
      </div>

      <p className="mt-4 border-l-2 pl-3 text-[15px] font-medium leading-snug tracking-tight" style={{ borderColor: s.sevColor }}>
        <Quote className="mb-1 mr-1 inline-block size-3.5 opacity-50" />
        {s.quote}
      </p>
      <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{s.note}</p>

      <div className="mt-4 grid grid-cols-2 gap-px border bg-border text-[11px]">
        <div className="bg-background p-2">
          <p className="meta-label">SRC</p>
          <p className="meta-value mt-0.5">{s.src.tc} · {s.src.dur}</p>
        </div>
        <div className="bg-background p-2">
          <p className="meta-label">EDIT</p>
          <p className="meta-value mt-0.5">{s.edit.tc} · {s.edit.dur}</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t pt-3">
        <span className="meta-value text-muted-foreground">
          similarity {(s.sim * 100).toFixed(0)}%
        </span>
        <ArrowUpRight className="size-4 text-muted-foreground/50 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[var(--trace-red)]" />
      </div>
      <span className="ct-specimen-rule absolute bottom-0 left-0 h-[2px] w-full bg-[var(--trace-red)]" aria-hidden />
    </motion.div>
  );
}

/* ————— Method section: sticky stage counter + scroll-linked rail ————— */

function MethodSection() {
  const listRef = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: listRef,
    offset: ["start 0.75", "end 0.55"],
  });
  const railScale = useSpring(scrollYProgress, { stiffness: 120, damping: 26 });

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-stage]"));
    if (rows.length === 0) return;
    const update = () => {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      rows.forEach((r, i) => {
        const rect = r.getBoundingClientRect();
        const dist = Math.abs(rect.top + rect.height / 2 - window.innerHeight * 0.45);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      setActive(best);
    };
    const io = new IntersectionObserver(update, {
      rootMargin: "-35% 0px -45% 0px",
    });
    rows.forEach((r) => io.observe(r));
    return () => io.disconnect();
  }, []);

  return (
    <div className="mt-14 grid gap-10 lg:grid-cols-[1fr_1.2fr]">
      {/* sticky stage number + progress rail */}
      <div className="lg:sticky lg:top-28 lg:self-start">
        <div className="relative pl-6">
          <span className="absolute bottom-1 left-0 top-1 w-[3px] bg-border" aria-hidden>
            <motion.span
              className="absolute left-0 top-0 w-full origin-top bg-[var(--trace-red)]"
              style={{ scaleY: railScale }}
            />
          </span>
          <p className="meta-label">stage</p>
          <p className="font-display text-7xl font-bold tracking-tight tabular-nums md:text-8xl">
            {STAGES[active].n}
            <span className="text-[var(--trace-red)]">/09</span>
          </p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            Each stage persists its outputs — transcripts, mappings, events —
            so the final report can cite exact evidence for every claim it
            makes.
          </p>
        </div>
      </div>

      <ol ref={listRef} className="space-y-px bg-border">
        {STAGES.map((st, i) => (
          <li key={st.n}>
            <MethodRow stage={st} index={i} active={active === i} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function MethodRow({
  stage,
  index,
  active,
}: {
  stage: (typeof STAGES)[number];
  index: number;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-30px" });
  return (
    <motion.div
      ref={ref}
      data-stage={index}
      initial={{ opacity: 0, x: 18 }}
      animate={inView ? { opacity: 1, x: 0 } : undefined}
      transition={{ duration: 0.5, delay: (index % 3) * 0.05, ease: EASE }}
      className={cn(
        "relative flex items-baseline gap-4 bg-background p-5 transition-colors duration-300",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      {active && (
        <motion.span
          layoutId="method-active-marker"
          className="absolute inset-y-0 left-0 w-[3px] bg-[var(--trace-red)]"
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
        />
      )}
      <span
        className={cn(
          "meta-value w-8 shrink-0",
          active ? "text-[var(--trace-red)]" : "text-muted-foreground/60",
        )}
      >
        {stage.n}
      </span>
      <div>
        <h3 className="font-semibold tracking-tight">{stage.t}</h3>
        <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">{stage.d}</p>
      </div>
    </motion.div>
  );
}

/* ————— Page ————— */

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const heroY = useTransform(heroProgress, [0, 1], [0, 140]);
  const heroOpacity = useTransform(heroProgress, [0, 0.75], [1, 0]);
  const ghostX = useTransform(heroProgress, [0, 1], ["0%", "-18%"]);

  const { scrollYProgress: pageProgress } = useScroll();
  const progressX = useSpring(pageProgress, { stiffness: 140, damping: 28, mass: 0.4 });

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-background">
      {/* scroll progress */}
      <motion.div
        className="fixed inset-x-0 top-0 z-50 h-[3px] origin-left bg-[var(--trace-red)]"
        style={{ scaleX: progressX }}
      />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-3">
            <svg viewBox="0 0 64 64" className="size-7" aria-hidden>
              <rect x="6" y="14" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="4" />
              <rect x="22" y="6" width="36" height="36" fill="none" stroke="var(--trace-red)" strokeWidth="4" />
              <rect x="26" y="30" width="8" height="8" fill="var(--trace-red)" />
            </svg>
            <span className="text-lg font-bold tracking-tight">
              Context<span className="text-[var(--trace-red)]">Trace</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {[
              ["Capabilities", "#capabilities"],
              ["Method", "#method"],
              ["Evidence", "#evidence"],
              ["Scope", "#scope"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="group relative px-3 py-2 text-sm font-medium tracking-tight text-muted-foreground transition-colors hover:text-foreground"
              >
                {label}
                <span className="absolute inset-x-3 bottom-1 h-[2px] origin-left scale-x-0 bg-[var(--trace-red)] transition-transform duration-300 group-hover:scale-x-100" />
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {isAuthenticated ? (
              <Button asChild size="sm">
                <Link to="/dashboard">
                  Dashboard <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/auth">Sign in</Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/auth">
                    Start Analysis <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ————— HERO ————— */}
      <section ref={heroRef} className="grid-paper relative overflow-hidden border-b">
        {/* ghost watermark */}
        <motion.p
          aria-hidden
          style={{ x: ghostX }}
          className="ct-outline pointer-events-none absolute -right-8 top-16 hidden select-none text-[11rem] font-bold leading-none lg:block"
        >
          TRACE
        </motion.p>

        <motion.div style={{ y: heroY, opacity: heroOpacity }} className="relative">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 pb-24 pt-20 md:pt-28 lg:grid-cols-[1.05fr_0.95fr] lg:pb-32">
            <div>
              <motion.p
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE }}
                className="meta-label inline-flex items-center gap-2 border border-[var(--trace-red)] bg-[var(--trace-red-soft)] px-2 py-1 text-[var(--trace-red)]"
              >
                <Fingerprint className="size-3.5" />
                AI media forensics · source vs. edit
              </motion.p>

              <h1 className="display-xl mt-6">
                <WordReveal text="Does the edit" />
                <br />
                <WordReveal text="change the" delay={0.18} />{" "}
                <span className="relative inline-block text-[var(--trace-red)]">
                  <WordReveal text="context?" delay={0.36} />
                  <motion.span
                    aria-hidden
                    className="absolute -bottom-1 left-0 h-[3px] w-full origin-left bg-[var(--trace-red)]"
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ delay: 0.9, duration: 0.5, ease: EASE }}
                  />
                </span>
              </h1>

              <motion.p
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55, duration: 0.6, ease: EASE }}
                className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground"
              >
                ContextTrace compares an original video against an edited or
                short-form derivative and shows exactly what changed — speech,
                order, captions — and whether those changes materially alter
                the context a viewer receives. Evidence, timestamps and
                confidence are always preserved.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7, duration: 0.6, ease: EASE }}
                className="mt-10 flex flex-wrap items-center gap-3"
              >
                <Button asChild size="lg" className="group h-12 px-8 text-base">
                  <Link to={isAuthenticated ? "/analysis/new" : "/auth"}>
                    Start Analysis
                    <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="h-12 px-8 text-base">
                  <Link to="/auth">Sign in</Link>
                </Button>
              </motion.div>

              {/* stats */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.05, duration: 0.7 }}
                className="mt-14 grid grid-cols-3 gap-6"
              >
                <CountStat value={16} decimals={0} label="signal features" sub="per frame" />
                <CountStat value={9} decimals={0} label="pipeline stages" sub="fully traced" />
                <CountStat value={98.33} decimals={2} suffix="%" label="eval accuracy" sub="held-out corpus" />
              </motion.div>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 32, rotate: 0.4 }}
              animate={{ opacity: 1, y: 0, rotate: 0 }}
              transition={{ delay: 0.35, duration: 0.8, ease: EASE }}
            >
              <HeroCompare />
            </motion.div>
          </div>
        </motion.div>

        {/* scroll cue */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.4 }}
          className="pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 lg:block"
        >
          <motion.div
            animate={{ y: [0, 7, 0] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
            className="flex flex-col items-center gap-1.5 text-muted-foreground"
          >
            <span className="meta-label">scroll</span>
            <ArrowDown className="size-4" />
          </motion.div>
        </motion.div>
      </section>

      {/* ————— TICKER ————— */}
      <div className="overflow-hidden border-b bg-foreground py-3 text-background">
        <div className="marquee-track-fast flex w-max items-center gap-8">
          {[0, 1].map((copy) => (
            <div key={copy} className="flex items-center gap-8" aria-hidden={copy === 1}>
              {TICKER.map((t) => (
                <span key={t} className="meta-label flex items-center gap-8 whitespace-nowrap">
                  {t}
                  <Scissors className="size-3.5 text-[var(--trace-red)]" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ————— CAPABILITIES (bento) ————— */}
      <section id="capabilities" className="scroll-mt-16 border-b">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <SectionHead
            label="Capabilities"
            title={<>An evidence workstation, <span className="ct-outline-strong">not a verdict machine.</span></>}
          />
          <div className="mt-14 grid gap-px border bg-border lg:grid-cols-6">
            {CAPABILITIES.map((cap, i) => (
              <motion.article
                key={cap.code}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.55, delay: i * 0.07, ease: EASE }}
                className={`group relative overflow-hidden bg-card p-8 transition-colors duration-300 hover:bg-secondary ${cap.span}`}
              >
                <div className="flex items-start justify-between">
                  <cap.icon className="size-6 text-[var(--trace-red)]" strokeWidth={1.5} />
                  <span className="meta-value text-muted-foreground/60 transition-colors group-hover:text-[var(--trace-red)]">
                    {cap.code}
                  </span>
                </div>
                <h3 className="mt-6 text-xl font-bold tracking-tight">{cap.title}</h3>
                <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{cap.body}</p>
                <ArrowUpRight className="absolute bottom-6 right-6 size-4 -translate-x-1 translate-y-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100" />
                <span className="absolute bottom-0 left-0 h-[2px] w-full origin-left scale-x-0 bg-[var(--trace-red)] transition-transform duration-500 group-hover:scale-x-100" />
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* ————— EVIDENCE MASONRY ————— */}
      <section id="evidence" className="scroll-mt-16 border-b bg-secondary/50">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHead
              label="Evidence specimens"
              title={<>Findings you can <span className="text-[var(--trace-red)]">pin</span>, inspect, replay.</>}
            />
            <Reveal delay={0.15}>
              <p className="meta-value max-w-xs text-muted-foreground">
                Every finding carries its category, severity, exact timecodes
                on both sides and a similarity score — like evidence cards
                pinned to a board.
              </p>
            </Reveal>
          </div>
          <div className="mt-14 columns-1 gap-5 md:columns-2 lg:columns-3 [&>*]:mb-5 [&>*]:break-inside-avoid">
            {SPECIMENS.map((s, i) => (
              <SpecimenCard key={s.kind} s={s} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ————— METHOD (sticky scroll) ————— */}
      <section id="method" className="scroll-mt-16 border-b">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <SectionHead label="Method" title={<>Nine stages, fully traced.</>} />
          <MethodSection />
        </div>
      </section>

      {/* ————— STATS BAND ————— */}
      <section className="border-b bg-secondary">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 py-16 sm:grid-cols-3">
          <CountStat value={98.33} decimals={2} suffix="%" label="held-out accuracy" sub="120-clip eval corpus" />
          <CountStat value={0.9975} decimals={4} label="ROC AUC" sub="score separability" />
          <CountStat value={100} decimals={0} suffix="%" label="edit recall" sub="on the hard subset" />
        </div>
      </section>

      {/* ————— LIMITATIONS ————— */}
      <section id="scope" className="scroll-mt-16 border-b">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <div className="max-w-3xl">
            <SectionHead
              label={<><Info className="size-4" /> Limitations & scope</>}
              title="Read the findings with the same care they were produced."
            />
            <div className="mt-10 space-y-px bg-border">
              {LIMITS.map((limit, i) => (
                <Reveal key={limit.tag} delay={i * 0.08}>
                  <div className="flex gap-5 bg-background p-5 transition-colors hover:bg-secondary">
                    <span className="meta-value mt-0.5 w-24 shrink-0 text-[var(--trace-red)]">
                      {String(i + 1).padStart(2, "0")} · {limit.tag}
                    </span>
                    <p className="text-sm leading-6 text-muted-foreground">{limit.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ————— FINAL CTA ————— */}
      <section className="relative overflow-hidden bg-foreground text-background">
        <motion.p
          aria-hidden
          className="ct-outline pointer-events-none absolute inset-x-0 bottom-2 select-none text-center text-[18vw] font-bold leading-none opacity-[0.07]"
        >
          CONTEXTTRACE
        </motion.p>
        <div className="relative mx-auto flex max-w-7xl flex-col items-start justify-between gap-10 px-6 py-24 md:flex-row md:items-center">
          <Reveal>
            <h2 className="display-lg">Run your first comparison.</h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-background/70">
              Upload a source video and its edited derivative. ContextTrace
              aligns the speech, detects the edit events, and returns an
              evidence-backed report with timestamps, confidence and coverage.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <Button
              asChild
              size="lg"
              variant="secondary"
              className="group h-14 shrink-0 bg-background px-10 text-base text-foreground hover:bg-background/90"
            >
              <Link to={isAuthenticated ? "/analysis/new" : "/auth"}>
                Start Analysis
                <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
            </Button>
          </Reveal>
        </div>
      </section>

      {/* ————— FOOTER ————— */}
      <footer className="border-t bg-background">
        <div className="mx-auto max-w-7xl px-6 py-14">
          <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
            <div>
              <div className="flex items-center gap-3">
                <svg viewBox="0 0 64 64" className="size-7" aria-hidden>
                  <rect x="6" y="14" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="4" />
                  <rect x="22" y="6" width="36" height="36" fill="none" stroke="var(--trace-red)" strokeWidth="4" />
                  <rect x="26" y="30" width="8" height="8" fill="var(--trace-red)" />
                </svg>
                <span className="text-lg font-bold tracking-tight">
                  Context<span className="text-[var(--trace-red)]">Trace</span>
                </span>
              </div>
              <p className="meta-value mt-4 max-w-sm leading-5 text-muted-foreground">
                Identifies evidence consistent with contextual change. Does not
                establish intent. Ordinary editing is not treated as manipulation.
              </p>
            </div>
            <div>
              <p className="meta-label">Product</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><Link className="text-muted-foreground transition-colors hover:text-foreground" to="/scan">Scan workbench</Link></li>
                <li><Link className="text-muted-foreground transition-colors hover:text-foreground" to="/history">Analysis history</Link></li>
                <li><Link className="text-muted-foreground transition-colors hover:text-foreground" to="/dashboard">Dashboard</Link></li>
              </ul>
            </div>
            <div>
              <p className="meta-label">Scope</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><a className="text-muted-foreground transition-colors hover:text-foreground" href="#capabilities">Capabilities</a></li>
                <li><a className="text-muted-foreground transition-colors hover:text-foreground" href="#method">Method</a></li>
                <li><a className="text-muted-foreground transition-colors hover:text-foreground" href="#scope">Limitations</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t pt-6">
            <p className="meta-label">ContextTrace · v1.0.0</p>
            <p className="meta-label">Identifies evidence — does not establish intent.</p>
          </div>
        </div>
      </footer>
      </div>
    </MotionConfig>
  );
}
