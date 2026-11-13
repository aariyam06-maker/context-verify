import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ArrowLeftRight, ScanSearch } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { JobTable } from "@/pages/History";
import { api, type JobSummary } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

export default function Dashboard() {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [health, setHealth] = useState<{ models: { aiDetector: boolean; tamper: boolean }; gemini: boolean } | null>(null);
  useEffect(() => {
    void api.jobs.list().then(setJobs).catch(() => setJobs([]));
    void api.health().then(setHealth).catch(() => undefined);
  }, []);

  return (
    <AppShell>
      <p className="meta-label">Workstation · {user?.email}</p>
      <h1 className="display-lg mt-2 text-4xl">What do you want to check?</h1>
      {health && (!health.models.aiDetector || !health.models.tamper) && (
        <p className="mt-4 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm">Models are not trained yet. Run <code>python start.py --train</code> once.</p>
      )}
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <ServiceCard to="/detect" icon={<ScanSearch className="size-6" />} kicker="Service 1 · one video" title="Is this video AI-generated?"
          text="Upload a single clip. Get the probability it was AI-generated, the share of its timeline that looks synthetic, and the forensic reasons." />
        <ServiceCard to="/tamper" icon={<ArrowLeftRight className="size-6" />} kicker="Service 2 · two videos" title="Which one was tampered with?"
          text="Upload two versions of the same evidence. Get AI + originality analysis of both, the located edits, and which file is the original." />
      </div>
      <div className="mt-12 flex items-end justify-between">
        <h2 className="text-lg font-bold tracking-tight">Recent analyses</h2>
        <Link to="/history" className="meta-label underline underline-offset-4">All history →</Link>
      </div>
      <div className="mt-3"><JobTable jobs={jobs?.slice(0, 8) ?? null} /></div>
      {health && <p className="meta-label mt-6">Models: AI detector {health.models.aiDetector ? "ready" : "missing"} · tamper model {health.models.tamper ? "ready" : "missing"} · Gemini second opinion {health.gemini ? "on" : "off (set GEMINI_API_KEY to enable)"}</p>}
    </AppShell>
  );
}

function ServiceCard({ to, icon, kicker, title, text }: { to: string; icon: React.ReactNode; kicker: string; title: string; text: string }) {
  return (
    <Link to={to} className="group flex flex-col justify-between gap-8 border bg-card p-7 transition-colors hover:border-foreground">
      <div>
        <div className="flex items-center gap-3 text-[var(--trace-red)]">{icon}<span className="meta-label">{kicker}</span></div>
        <p className="mt-4 text-2xl font-bold tracking-tight">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{text}</p>
      </div>
      <span className="inline-flex items-center gap-2 text-sm font-semibold">Start <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" /></span>
    </Link>
  );
}
