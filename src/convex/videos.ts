import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ---------------------------------------------------------------------------
// Video records. Files themselves live in browser-local storage (IndexedDB,
// keyed by storageKey) so the owner's session can replay them in the
// synchronized timeline. Metadata + validation state live here.
// ---------------------------------------------------------------------------

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export const register = mutation({
  args: {
    type: v.union(v.literal("source"), v.literal("edited"), v.literal("scan")),
    filename: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    durationSeconds: v.number(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    hasAudio: v.boolean(),
    storageKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required.");

    if (!args.filename.match(/\.(mp4|mov|webm|mkv|avi|m4v)$/i)) {
      return {
        ok: false as const,
        reason: "Unsupported format. Accepted: mp4, mov, webm, mkv, avi, m4v.",
      };
    }
    if (args.byteSize > MAX_BYTES) {
      return { ok: false as const, reason: "File exceeds the 500 MB limit." };
    }
    if (args.durationSeconds <= 0) {
      return {
        ok: false as const,
        reason:
          "Media could not be read (duration unknown). The file may be corrupt or unsupported.",
      };
    }

    const videoId = await ctx.db.insert("videos", {
      ownerId: userId,
      type: args.type,
      filename: args.filename,
      mimeType: args.mimeType,
      byteSize: args.byteSize,
      storageKey: args.storageKey,
      durationSeconds: args.durationSeconds,
      width: args.width,
      height: args.height,
      hasAudio: args.hasAudio,
      validationStatus: "uploaded",
      validationMessage: "Validated client-side: readable, supported container, non-zero duration.",
      createdAt: Date.now(),
    });
    return { ok: true as const, videoId };
  },
});

/** Fetch a video the current user owns (used by createJob action). */
export const getOwned = query({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const video = await ctx.db.get(args.videoId);
    if (!video || video.ownerId !== userId) return null;
    return video;
  },
});

/** List the current user's videos (uploads view, debugging, admin later). */
export const listOwned = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("videos")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(50);
  },
});
