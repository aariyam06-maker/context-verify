import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { formatPercent, timeAgo, formatDateTime, type JobMode } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { STATUS_CLASSES, type JobStatus } from "@/lib/trace";
import { Search } from "lucide-react";
import { useNavigate } from "react-router";

type JobRow = {
  _id: string;
  mode: JobMode;
  status: JobStatus;
  progress: number;
  createdAt: number;
  errorMessage?: string | null;
  sourceFilename: string;
  editedFilename: string;
  report: { score: number; overallConfidence: number; degraded: boolean; mode: JobMode; aiScore?: number; mitigated?: boolean } | null;
};

const FILTERS = ["all", "completed", "degraded", "running", "failed", "queued"] as const;

const NO_JOBS: JobRow[] = [];

export default function History() {
  const jobs = useQuery(api.jobs.listJobs) ?? NO_JOBS;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      const map: Record<string, JobStatus> = {
        completed: "COMPLETED",
        degraded: "DEGRADED",
        running: "RUNNING",
        failed: "FAILED",
        queued: "QUEUED",
      };
      if (filter !== "all" && j.status !== map[filter]) return false;
      if (!q) return true;
      return (
        j.sourceFilename.toLowerCase().includes(q) ||
        j.editedFilename.toLowerCase().includes(q)
      );
    });
  }, [jobs, query, filter]);

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Archive</p>
          <h1 className="display-lg mt-2 text-4xl">Analysis History</h1>
        </div>
        <p className="meta-label max-w-xs text-right leading-5">
          Completed reports reopen without re-uploading. Local video files
          replay when stored in this browser.
        </p>
      </div>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search source or edited filename…"
            className="h-9 w-72 pl-9"
          />
        </div>
        <div className="flex border">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "meta-label border-r px-3 py-2 last:border-r-0 hover:bg-secondary",
                filter === f && "bg-foreground text-background hover:bg-foreground",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="meta-label ml-auto">
          {filtered.length} of {jobs.length} analyses
        </span>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto border">
        {filtered.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="meta-label">Nothing matches</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {jobs.length === 0
                ? "No analyses yet — run your first comparison from New Analysis."
                : "Adjust the search or filter to see more results."}
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b bg-secondary">
                {["Date", "Source", "Edited", "Status", "Score", "Confidence", "Opened"].map(
                  (h) => (
                    <th key={h} className="meta-label px-4 py-2.5 text-left font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((job) => {
                const isScan = job.mode === "scan" || job.mode === "mitigation";
                const target = isScan
                  ? `/scan/${job._id}`
                  : job.status === "COMPLETED" || job.status === "DEGRADED" || job.status === "FAILED"
                    ? `/analysis/${job._id}`
                    : `/analysis/${job._id}/progress`;
                return (
                  <tr
                    key={job._id}
                    onClick={() => navigate(target)}
                    className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-secondary"
                  >
                    <td className="px-4 py-3 meta-value whitespace-nowrap text-muted-foreground" title={formatDateTime(job.createdAt)}>
                      {timeAgo(job.createdAt)}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 meta-value" title={job.sourceFilename}>
                      {job.sourceFilename}
                      {isScan && (
                        <span className="meta-label ml-2 text-[var(--trace-blue)]">SCAN</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 meta-value" title={job.editedFilename}>
                      {job.editedFilename}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "px-1.5 py-0.5 text-[10px] font-semibold tracking-widest",
                          STATUS_CLASSES[job.status],
                        )}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 meta-value font-semibold">
                      {job.report ? (isScan ? `${job.report.score}%` : job.report.score) : "—"}
                    </td>
                    <td className="px-4 py-3 meta-value text-muted-foreground">
                      {job.report ? formatPercent(job.report.overallConfidence) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="meta-label">
                        {job.report ? "Open report →" : "Details →"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
