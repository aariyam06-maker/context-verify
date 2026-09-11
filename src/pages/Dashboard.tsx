import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppShell } from "@/components/AppShell";
import {
  STATUS_CLASSES,
  formatPercent,
  timeAgo,
  type JobStatus,
} from "@/lib/trace";
import { cn } from "@/lib/utils";
import { FilePlus2, Search } from "lucide-react";
import { Link, useNavigate } from "react-router";

type JobRow = {
  _id: string;
  status: JobStatus;
  currentStage?: string | null;
  progress: number;
  createdAt: number;
  completedAt?: number | null;
  errorMessage?: string | null;
  warnings: string[];
  sourceFilename: string;
  editedFilename: string;
  sourceVideoKey: string | null;
  editedVideoKey: string | null;
  report: { score: number; overallConfidence: number; degraded: boolean } | null;
};

const STATUS_FILTERS = ["all", "COMPLETED", "DEGRADED", "RUNNING", "FAILED", "QUEUED"] as const;

const NO_JOBS: JobRow[] = [];

export default function Dashboard() {
  const { user } = useAuth();
  const jobs = useQuery(api.jobs.listJobs) ?? NO_JOBS;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<(typeof STATUS_FILTERS)[number]>("all");

  const stats = useMemo(() => {
    const by = (s: JobStatus) => jobs.filter((j) => j.status === s).length;
    return {
      total: jobs.length,
      completed: by("COMPLETED"),
      running: by("RUNNING") + by("QUEUED"),
      degraded: by("DEGRADED"),
      failed: by("FAILED"),
    };
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (!q) return true;
      return (
        j.sourceFilename.toLowerCase().includes(q) ||
        j.editedFilename.toLowerCase().includes(q)
      );
    });
  }, [jobs, query, statusFilter]);

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Workstation · {user?.email ?? "guest"}</p>
          <h1 className="display-lg mt-2 text-4xl">Dashboard</h1>
        </div>
        <Button asChild size="lg" className="h-12 px-6">
          <Link to="/analysis/new">
            <FilePlus2 className="size-4" /> New Analysis
          </Link>
        </Button>
      </div>

      {/* Counters */}
      <div className="mt-8 grid grid-cols-2 gap-px border bg-border md:grid-cols-5">
        <Counter label="Total analyses" value={stats.total} />
        <Counter label="Completed" value={stats.completed} accent="blue" />
        <Counter label="Running" value={stats.running} accent="pulse" />
        <Counter label="Degraded" value={stats.degraded} accent="red" />
        <Counter label="Failed" value={stats.failed} accent="red" />
      </div>

      {/* Filters */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight">Analysis history</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filenames…"
              className="h-9 w-56 pl-9"
            />
          </div>
          <div className="flex border">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "meta-label border-r px-2.5 py-1.5 last:border-r-0 hover:bg-secondary",
                  statusFilter === s && "bg-foreground text-background hover:bg-foreground",
                )}
              >
                {s.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* History table */}
      <div className="mt-4 border">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <p className="meta-label">No analyses yet</p>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Run your first source-vs-edit comparison to see reports here.
            </p>
            <Button asChild className="mt-6">
              <Link to="/analysis/new">
                <FilePlus2 className="size-4" /> New Analysis
              </Link>
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary">
                {["Date", "Source", "Edited", "Status", "Score", "Conf.", ""].map(
                  (h) => (
                    <th
                      key={h}
                      className="meta-label px-4 py-2.5 text-left font-medium"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 25).map((job) => (
                <JobRowView key={job._id} job={job} onOpen={navigate} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

function JobRowView({
  job,
  onOpen,
}: {
  job: JobRow;
  onOpen: (path: string) => void;
}) {
  const open = () => {
    if (job.report || job.status === "FAILED") {
      onOpen(`/analysis/${job._id}`);
    } else {
      onOpen(`/analysis/${job._id}/progress`);
    }
  };
  return (
    <tr
      onClick={open}
      className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-secondary"
    >
      <td className="px-4 py-3 meta-value text-muted-foreground">
        {timeAgo(job.createdAt)}
      </td>
      <td className="max-w-[180px] truncate px-4 py-3 meta-value" title={job.sourceFilename}>
        {job.sourceFilename}
      </td>
      <td className="max-w-[180px] truncate px-4 py-3 meta-value" title={job.editedFilename}>
        {job.editedFilename}
      </td>
      <td className="px-4 py-3">
        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold tracking-widest", STATUS_CLASSES[job.status])}>
          {job.status}
        </span>
      </td>
      <td className="px-4 py-3 meta-value font-semibold">
        {job.report ? job.report.score : "—"}
      </td>
      <td className="px-4 py-3 meta-value text-muted-foreground">
        {job.report ? formatPercent(job.report.overallConfidence) : "—"}
      </td>
      <td className="px-4 py-3 text-right">
        <span className="meta-label">
          {job.report ? "Open →" : job.status === "RUNNING" || job.status === "QUEUED" ? "Progress →" : "Details →"}
        </span>
      </td>
    </tr>
  );
}

function Counter({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "blue" | "red" | "pulse";
}) {
  return (
    <div className="bg-card p-5">
      <p className="meta-label">{label}</p>
      <p
        className={cn(
          "mt-1 text-3xl font-bold tracking-tight",
          accent === "blue" && "text-[var(--trace-blue)]",
          accent === "red" && "text-[var(--trace-red)]",
          accent === "pulse" && "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}
