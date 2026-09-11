import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "react-router";
import { motion } from "framer-motion";
import {
  AudioLines,
  Layers,
  ScanSearch,
  ArrowRight,
  Info,
} from "lucide-react";

const CAPABILITIES = [
  {
    icon: AudioLines,
    title: "Speech Alignment",
    code: "01",
    body: "Timestamped transcription of both videos, then semantic correspondence matching. Every aligned, missing and reordered statement is traced to exact timecodes on both sides.",
  },
  {
    icon: Layers,
    title: "Multimodal Evidence",
    code: "02",
    body: "Speech is the primary signal; visual correspondence and on-screen text (OCR) contribute supporting evidence. No single modality ever stands alone as proof.",
  },
  {
    icon: ScanSearch,
    title: "Context Impact Analysis",
    code: "03",
    body: "Detected edits — omissions, reordering, splices, discontinuities — are assessed for whether they materially change the meaning conveyed to viewers.",
  },
];

const LIMITS = [
  "ContextTrace identifies evidence consistent with contextual change. It does not establish intent, and it does not label ordinary editing as malicious.",
  "A missing or non-contiguous mapping is a candidate edit event — never automatically misinformation or deception.",
  "Scores are transparent and evidence-backed, not a black-box verdict. Confidence, coverage and uncertainty accompany every result.",
];

export default function Landing() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
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
          <nav className="flex items-center gap-2">
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
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="grid-paper border-b">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="max-w-4xl"
          >
            <p className="meta-label border border-[var(--trace-red)] bg-[var(--trace-red-soft)] px-2 py-1 inline-block text-[var(--trace-red)]">
              AI media forensics · source vs. edit
            </p>
            <h1 className="display-xl mt-6">
              Does the edit
              <br />
              change the <span className="text-[var(--trace-red)]">context?</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              ContextTrace compares an original video against an edited or
              short-form derivative and shows exactly what changed — speech,
              order, captions — and whether those changes materially alter the
              context a viewer receives. Evidence, timestamps and confidence
              are always preserved. Ordinary editing is not treated as
              manipulation.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-12 px-8 text-base">
                <Link to={isAuthenticated ? "/analysis/new" : "/auth"}>
                  Start Analysis <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-12 px-8 text-base">
                <Link to="/auth">Sign in</Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-b">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <p className="meta-label">Capabilities</p>
          <h2 className="display-lg mt-3 max-w-2xl">
            An evidence workstation, not a verdict machine.
          </h2>
          <div className="mt-12 grid gap-px border bg-border md:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <motion.article
                key={cap.code}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.4 }}
                className="group bg-card p-8 transition-colors hover:bg-secondary"
              >
                <div className="flex items-center justify-between">
                  <cap.icon className="size-6 text-[var(--trace-red)]" strokeWidth={1.5} />
                  <span className="meta-value text-muted-foreground/60">
                    {cap.code}
                  </span>
                </div>
                <h3 className="mt-6 text-xl font-bold tracking-tight">
                  {cap.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {cap.body}
                </p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* Method strip */}
      <section className="border-b bg-secondary">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
            <div>
              <p className="meta-label">Method</p>
              <h2 className="display-lg mt-3">Nine stages, fully traced.</h2>
            </div>
            <ol className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {[
                "Media validation & pre-processing",
                "Timestamped speech transcription",
                "Semantic speech alignment",
                "Representative-frame extraction",
                "Visual correspondence",
                "OCR / caption extraction",
                "Edit-event detection",
                "Contextual-impact assessment",
                "Evidence-backed report",
              ].map((step, i) => (
                <li key={step} className="flex items-baseline gap-3 border-b py-2">
                  <span className="meta-value text-[var(--trace-red)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm font-medium tracking-tight">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Limitations */}
      <section className="border-b">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <div className="max-w-3xl">
            <p className="meta-label flex items-center gap-2">
              <Info className="size-4" /> Limitations & scope
            </p>
            <ul className="mt-6 space-y-5">
              {LIMITS.map((limit, i) => (
                <li key={i} className="flex gap-4 border-l-2 border-border pl-5">
                  <p className="text-sm leading-6 text-muted-foreground">{limit}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-foreground text-background">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-6 py-20 md:flex-row md:items-center">
          <div>
            <h2 className="display-lg">Run your first comparison.</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-background/70">
              Upload a source video and its edited derivative. ContextTrace
              aligns the speech, detects the edit events, and returns an
              evidence-backed report.
            </p>
          </div>
          <Button
            asChild
            size="lg"
            variant="secondary"
            className="h-12 shrink-0 bg-background px-8 text-base text-foreground hover:bg-background/90"
          >
            <Link to={isAuthenticated ? "/analysis/new" : "/auth"}>
              Start Analysis <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-6">
          <p className="meta-label">ContextTrace · v1.0.0</p>
          <p className="meta-label">
            Identifies evidence — does not establish intent.
          </p>
        </div>
      </footer>
    </div>
  );
}
