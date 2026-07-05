// Privileged user management, the Convex replacement for the `admin-users`
// Supabase edge function. Every function verifies the caller's session token
// resolves to an active admin before doing anything.
import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { sessionUser, publicUser } from "./auth";

async function requireAdmin(ctx: QueryCtx | MutationCtx, token: string) {
  const su = await sessionUser(ctx, token);
  if (!su || su.user.role !== "admin" || su.user.is_active === false) {
    return null;
  }
  return su;
}

export const listUsers = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const su = await requireAdmin(ctx, token);
    if (!su) return { ok: false, error: "Forbidden: administrator access required" };
    const users = await ctx.db.query("users").collect();
    users.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { ok: true, users: users.map(publicUser) };
  },
});

export const listAudit = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit }) => {
    const su = await requireAdmin(ctx, token);
    if (!su) return { ok: false, error: "Forbidden: administrator access required" };
    const rows = await ctx.db
      .query("audit_logs")
      .withIndex("by_login_at")
      .order("desc")
      .take(Math.min(limit ?? 500, 1000));
    return {
      ok: true,
      logs: rows.map((r) => ({ ...r, id: r._id })),
    };
  },
});

export const setRole = mutation({
  args: { token: v.string(), user_id: v.string(), role: v.string() },
  handler: async (ctx, { token, user_id, role }) => {
    const su = await requireAdmin(ctx, token);
    if (!su) return { ok: false, error: "Forbidden: administrator access required" };
    if (!["viewer", "admin"].includes(role)) {
      return { ok: false, error: "Invalid parameters" };
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_uid", (q) => q.eq("uid", user_id))
      .unique();
    if (!target) return { ok: false, error: "User not found" };
    await ctx.db.patch(target._id, {
      role,
      updated_at: new Date().toISOString(),
    });
    return { ok: true, user_id, role };
  },
});

export const setActive = mutation({
  args: { token: v.string(), user_id: v.string(), active: v.boolean() },
  handler: async (ctx, { token, user_id, active }) => {
    const su = await requireAdmin(ctx, token);
    if (!su) return { ok: false, error: "Forbidden: administrator access required" };
    if (user_id === su.user.uid) {
      return { ok: false, error: "You cannot deactivate your own account" };
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_uid", (q) => q.eq("uid", user_id))
      .unique();
    if (!target) return { ok: false, error: "User not found" };
    await ctx.db.patch(target._id, {
      is_active: active,
      updated_at: new Date().toISOString(),
    });
    if (!active) {
      // Enforce immediately: kill all of the user's sessions (the old system
      // banned the user at the auth level; here sessions are the auth level).
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("user_uid", user_id))
        .collect();
      for (const s of sessions) await ctx.db.delete(s._id);
    }
    return { ok: true, user_id, is_active: active };
  },
});

export const deleteUser = mutation({
  args: { token: v.string(), user_id: v.string() },
  handler: async (ctx, { token, user_id }) => {
    const su = await requireAdmin(ctx, token);
    if (!su) return { ok: false, error: "Forbidden: administrator access required" };
    if (user_id === su.user.uid) {
      return { ok: false, error: "You cannot delete your own account" };
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_uid", (q) => q.eq("uid", user_id))
      .unique();
    if (!target) return { ok: false, error: "User not found" };
    await ctx.db.delete(target._id);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("user_uid", user_id))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);
    // Keep audit rows (they're the trail) but detach them from the deleted
    // user, mirroring the old FK ON DELETE SET NULL behaviour.
    const logs = await ctx.db
      .query("audit_logs")
      .withIndex("by_user", (q) => q.eq("user_id", user_id))
      .collect();
    for (const log of logs) await ctx.db.patch(log._id, { user_id: undefined });
    return { ok: true, deleted: user_id };
  },
});
