import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, ArrowRight, Cpu, Fingerprint, ScanSearch, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import logo from "@/assets/logo.svg";

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:8000/api";

type Summary = { ai?: { cvAccuracy?: number; oodAccuracy?: number; trainVideos?: number; sources?: number }; tamper?: { cvAccuracy?: number; pairs?: number }; acceptance?: { detect_accuracy?: number; tamper_accuracy?: number } };

const pct = (v?: number) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => { void fetch(`${API}/models/summary`).then((r) => r.json()).then(setS).catch(() => setS(null)); }, []);
  const start = isAuthenticated ? "/dashboard" : "/auth";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-3"><img src={logo} alt="" className="size-7" /><span className="text-lg font-bold tracking-tight">Context<span className="text-[var(--trace-red)]">Trace</span></span></Link>
          <Button asChild variant="outline"><Link to={start}>{isAuthenticated ? "Open workstation" : "Sign in · demo"}</Link></Button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-16 pt-20">
        <p className="meta-label">AI media forensics</p>
        <h1 className="display-lg mt-4 max-w-3xl text-5xl leading-[1.05]">Is this video AI-generated? Which copy of the evidence was tampered with?</h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">ContextTrace answers both with locally-run neural networks and video forensics — no cloud upload required. Every verdict comes with a probability, a timeline and the evidence behind it.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg" className="h-12 px-6"><Link to={isAuthenticated ? "/detect" : "/auth"}><ScanSearch className="size-4" />Detect AI video</Link></Button>
          <Button asChild size="lg" variant="outline" className="h-12 px-6"><Link to={isAuthenticated ? "/tamper" : "/auth"}><ArrowLeftRight className="size-4" />Check two videos for tampering</Link></Button>
        </div>
      </section>

      <section className="border-y bg-card">
        <div className="mx-auto grid max-w-6xl gap-px bg-border md:grid-cols-4">
          <Stat label="AI detector · held-out sources" value={pct(s?.ai?.oodAccuracy)} sub="never-seen generators & cameras" />
          <Stat label="AI detector · cross-validated" value={pct(s?.ai?.cvAccuracy)} sub={`${s?.ai?.trainVideos ?? "—"} videos · ${s?.ai?.sources ?? "—"} datasets`} />
          <Stat label="Tamper direction · cross-validated" value={pct(s?.tamper?.cvAccuracy)} sub={`${s?.tamper?.pairs ?? "—"} original/tampered pairs`} />
          <Stat label="Acceptance tests (random clips)" value={s?.acceptance ? `${pct(s.acceptance.detect_accuracy)} / ${pct(s.acceptance.tamper_accuracy)}` : "—"} sub="detection / tamper scenarios" />
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-6 py-16 md:grid-cols-2">
        <Card icon={<ScanSearch className="size-6" />} kicker="Service 1 · one video" title="AI-generated video detection"
          points={["Calibrated probability that the clip is AI-generated", "AI content share — what % of the timeline is synthetic", "Per-frame timeline to locate AI segments", "Plain-language forensic reasons"]} />
        <Card icon={<ArrowLeftRight className="size-6" />} kicker="Service 2 · two videos" title="Evidence tamper check"
          points={["Declares which file is the original and which is tampered", "Locates inserted, removed, re-ordered and sped-up footage", "Finds in-frame edits: object removal, cloning, fake captions", "AI + originality analysis of both videos"]} />
      </section>

      <section className="border-t">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <p className="meta-label">How it works</p>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            <Step icon={<Cpu className="size-5" />} title="Neural vision backbone" text="CLIP ViT-B/32 embeddings of sampled frames (the UnivFD approach) capture semantic traces left by generators." />
            <Step icon={<Waves className="size-5" />} title="Signal forensics" text="Noise-residual statistics, frequency-spectrum shape, compression traces and optical-flow consistency measure physics a camera produces." />
            <Step icon={<Fingerprint className="size-5" />} title="Alignment & provenance" text="For two videos, block-robust frame alignment and cut detection reveal what was added, removed or edited — and in which direction." />
          </div>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6">
          <p className="meta-label">ContextTrace v4 · forensic indicators, not legal proof</p>
          <Link to={start} className="inline-flex items-center gap-2 text-sm font-semibold">Get started <ArrowRight className="size-4" /></Link>
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="bg-card p-6"><p className="meta-label">{label}</p><p className="mt-2 text-3xl font-bold tracking-tight">{value}</p><p className="mt-1 text-xs text-muted-foreground">{sub}</p></div>;
}

function Card({ icon, kicker, title, points }: { icon: React.ReactNode; kicker: string; title: string; points: string[] }) {
  return (
    <div className="border bg-card p-7">
      <div className="flex items-center gap-3 text-[var(--trace-red)]">{icon}<span className="meta-label">{kicker}</span></div>
      <p className="mt-4 text-2xl font-bold tracking-tight">{title}</p>
      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">{points.map((p) => <li key={p}>• {p}</li>)}</ul>
    </div>
  );
}

function Step({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="border p-6"><div className="text-[var(--trace-blue)]">{icon}</div><p className="mt-3 font-semibold">{title}</p><p className="mt-2 text-sm text-muted-foreground">{text}</p></div>;
}
