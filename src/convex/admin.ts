import { v } from "convex/values";
import { QueryCtx, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ---------------------------------------------------------------------------
// Admin / review: role-protected queries. Every handler re-checks the caller's
// role server-side; the frontend gate is cosmetic only.
// ---------------------------------------------------------------------------

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "admin") return null;
  return user;
}

export const adminOverview = query({
  args: {},
  handler: async (ctx) => {
    const admin = await requireAdmin(ctx);
    if (!admin) return null;

    const users = await ctx.db.query("users").collect();
    const jobs = await ctx.db
      .query("analysisJobs")
      .withIndex("by_status", (q) => q.eq("status", "RUNNING"))
      .collect();
    const allJobs = await ctx.db.query("analysisJobs").collect();

    const withOwners = await Promise.all(
      allJobs
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map(async (job) => {
          const owner = await ctx.db.get(job.ownerId);
          const sourceVideo = await ctx.db.get(job.sourceVideoId);
          const editedVideo = await ctx.db.get(job.editedVideoId);
          const report =
            job.status === "COMPLETED" || job.status === "DEGRADED"
              ? await ctx.db
                  .query("reports")
                  .withIndex("by_job", (q) => q.eq("jobId", job._id))
                  .first()
              : null;
          return {
            _id: job._id,
            status: job.status,
            currentStage: job.currentStage,
            progress: job.progress,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            errorMessage: job.errorMessage,
            warnings: job.warnings ?? [],
            ownerEmail: owner?.email ?? "—",
            sourceFilename: sourceVideo?.filename ?? "—",
            editedFilename: editedVideo?.filename ?? "—",
            score: report?.score ?? null,
          };
        }),
    );

    return {
      stats: {
        users: users.length,
        jobs: allJobs.length,
        running: jobs.length,
        degraded: allJobs.filter((j) => j.status === "DEGRADED").length,
        failed: allJobs.filter((j) => j.status === "FAILED").length,
        completed: allJobs.filter((j) => j.status === "COMPLETED").length,
      },
      jobs: withOwners,
      users: users.map((u) => ({
        _id: u._id,
        email: u.email ?? null,
        name: u.name ?? null,
        role: u.role ?? null,
        createdAt: u._creationTime,
      })),
    };
  },
});
