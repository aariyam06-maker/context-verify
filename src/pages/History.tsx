import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api, type JobSummary } from "@/lib/api";
import { timeAgo } from "@/lib/trace";
import { cn } from "@/lib/utils";

function outcome(j: JobSummary): { text: string; tone: "red" | "blue" | "muted" } {
  const h = j.headline;
  if (j.status === "FAILED") return { text: "failed", tone: "red" };
  if (!h) return { text: `${j.status.toLowerCase()} · ${j.progress}%`, tone: "muted" };
  if (j.mode === "detect") return { text: `${h.verdictLabel} · ${Number(h.aiProbability).toFixed(0)}% AI`, tone: h.verdict === "ai_generated" ? "red" : "blue" };
  if (h.verdict === "tampered") return { text: `${(h.tampered as string).toUpperCase()} tampered · original ${(h.original as string).toUpperCase()}`, tone: "red" };
  return { text: h.verdict === "no_tampering" ? "no tampering" : "unrelated videos", tone: "blue" };
}

export function JobTable({ jobs, onDelete }: { jobs: JobSummary[] | null; onDelete?: (id: string) => void }) {
  const navigate = useNavigate();
  if (jobs === null) return <p className="border p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!jobs.length) return <p className="border p-6 text-sm text-muted-foreground">No analyses yet — start with one of the two services above.</p>;
  return (
    <div className="overflow-x-auto border">
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-secondary">{["When", "Service", "Video(s)", "Outcome", ""].map((h) => <th key={h} className="meta-label px-4 py-2.5 text-left font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {jobs.map((j) => {
            const o = outcome(j);
            return (
              <tr key={j._id} onClick={() => navigate(`/result/${j._id}`)} className="cursor-pointer border-b last:border-b-0 hover:bg-secondary">
                <td className="meta-value whitespace-nowrap px-4 py-3 text-muted-foreground">{timeAgo(j.createdAt)}</td>
                <td className="px-4 py-3"><span className="meta-label">{j.mode === "detect" ? "AI detection" : "Tamper check"}</span></td>
                <td className="meta-value max-w-[320px] truncate px-4 py-3">{j.mode === "detect" ? j.videoA : `${j.videoA} ⇄ ${j.videoB}`}</td>
                <td className={cn("px-4 py-3 font-semibold", o.tone === "red" && "text-[var(--trace-red)]", o.tone === "blue" && "text-[var(--trace-blue)]")}>{o.text}</td>
                <td className="px-4 py-3 text-right">
                  {onDelete && <button type="button" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(j._id); }} className="p-1 hover:text-[var(--trace-red)]"><Trash2 className="size-4" /></button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function History() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const load = () => void api.jobs.list().then(setJobs).catch(() => setJobs([]));
  useEffect(load, []);
  return (
    <AppShell>
      <h1 className="display-lg text-4xl">History</h1>
      <p className="mt-2 text-muted-foreground">Every analysis you ran, newest first.</p>
      <div className="mt-6"><JobTable jobs={jobs} onDelete={(id) => void api.jobs.remove(id).then(load)} /></div>
    </AppShell>
  );
}
