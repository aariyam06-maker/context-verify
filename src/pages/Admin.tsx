import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { formatDateTime } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { STATUS_CLASSES, type JobStatus } from "@/lib/trace";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router";

type AdminJob = {
  _id: string;
  status: JobStatus;
  currentStage?: string | null;
  progress: number;
  createdAt: number;
  completedAt?: number | null;
  errorMessage?: string | null;
  warnings: string[];
  ownerEmail: string;
  sourceFilename: string;
  editedFilename: string;
  score: number | null;
};

type AdminOverview = {
  stats: {
    users: number;
    jobs: number;
    running: number;
    degraded: number;
    failed: number;
    completed: number;
  };
  jobs: AdminJob[];
  users: {
    _id: string;
    email: string | null;
    name: string | null;
    role: string | null;
    createdAt: number;
  }[];
};

export default function Admin() {
  const data = useQuery(api.admin.adminOverview) as
    | AdminOverview
    | null
    | undefined;
  const navigate = useNavigate();

  if (data === undefined) {
    return (
      <AppShell>
        <div className="flex items-center gap-3 py-24">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="meta-label">Loading review console…</span>
        </div>
      </AppShell>
    );
  }

  if (data === null) {
    return (
      <AppShell>
        <div className="py-24 text-center">
          <p className="meta-label text-[var(--trace-red)]">403</p>
          <h1 className="display-lg mt-2 text-3xl">Admin access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account role does not grant access to the review console.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Role-protected · review console</p>
          <h1 className="display-lg mt-2 text-4xl">Admin / Review</h1>
        </div>
        <p className="meta-label max-w-xs text-right leading-5">
          Server-side role check on every query — this page is cosmetic
          gating only.
        </p>
      </div>

      {/* Stats */}
      <div className="mt-8 grid grid-cols-2 gap-px border bg-border md:grid-cols-7">
        <Stat label="Users" value={data.stats.users} />
        <Stat label="Jobs" value={data.stats.jobs} />
        <Stat label="Running" value={data.stats.running} />
        <Stat label="Completed" value={data.stats.completed} accent="blue" />
        <Stat label="Degraded" value={data.stats.degraded} accent="red" />
        <Stat label="Failed" value={data.stats.failed} accent="red" />
        <Stat label="Queued" value={data.stats.jobs - data.stats.running - data.stats.completed - data.stats.degraded - data.stats.failed} />
      </div>

      {/* Jobs */}
      <h2 className="mt-10 text-lg font-bold tracking-tight">Analysis jobs</h2>
      <div className="mt-4 overflow-x-auto border">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b bg-secondary">
              {["Created", "Owner", "Source → Edited", "Status", "Stage", "Score", "Error"].map((h) => (
                <th key={h} className="meta-label px-4 py-2.5 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center meta-label">
                  No jobs on the platform yet
                </td>
              </tr>
            )}
            {data.jobs.map((job) => (
              <tr
                key={job._id}
                onClick={() => navigate(
                  job.status === "COMPLETED" || job.status === "DEGRADED" || job.status === "FAILED"
                    ? `/analysis/${job._id}`
                    : `/analysis/${job._id}/progress`,
                )}
                className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-secondary"
              >
                <td className="px-4 py-3 meta-value whitespace-nowrap text-muted-foreground">
                  {formatDateTime(job.createdAt)}
                </td>
                <td className="max-w-[180px] truncate px-4 py-3 meta-value" title={job.ownerEmail}>
                  {job.ownerEmail}
                </td>
                <td className="max-w-[260px] truncate px-4 py-3 meta-value">
                  {job.sourceFilename} <span className="text-muted-foreground">→</span> {job.editedFilename}
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
                <td className="px-4 py-3 meta-value text-muted-foreground">
                  {job.currentStage?.replace(/_/g, " ") ?? "—"}
                </td>
                <td className="px-4 py-3 meta-value font-semibold">
                  {job.score ?? "—"}
                </td>
                <td className="max-w-[220px] truncate px-4 py-3 meta-value text-[var(--trace-red)]" title={job.errorMessage ?? ""}>
                  {job.errorMessage ?? (job.warnings.length > 0 ? `${job.warnings.length} warning(s)` : "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Users */}
      <h2 className="mt-10 text-lg font-bold tracking-tight">Users</h2>
      <div className="mt-4 border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-secondary">
              {["Email", "Name", "Role", "Joined"].map((h) => (
                <th key={h} className="meta-label px-4 py-2.5 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u._id} className="border-b last:border-b-0">
                <td className="px-4 py-3 meta-value">{u.email ?? "(anonymous)"}</td>
                <td className="px-4 py-3 meta-value text-muted-foreground">
                  {u.name ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span className="meta-label border px-1.5 py-0.5">
                    {u.role ?? "user"}
                  </span>
                </td>
                <td className="px-4 py-3 meta-value text-muted-foreground">
                  {formatDateTime(u.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "blue" | "red";
}) {
  return (
    <div className="bg-card p-4">
      <p className="meta-label">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-bold tracking-tight",
          accent === "blue" && "text-[var(--trace-blue)]",
          accent === "red" && "text-[var(--trace-red)]",
        )}
      >
        {value}
      </p>
    </div>
  );
}
