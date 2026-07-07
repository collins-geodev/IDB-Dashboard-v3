import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// Resolve a session token to its (unexpired) session + user, or null.
export async function sessionUser(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined
): Promise<{ session: Doc<"sessions">; user: Doc<"users"> } | null> {
  if (!token) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_uid", (q) => q.eq("uid", session.user_uid))
    .unique();
  if (!user) return null;
  return { session, user };
}

// Shape the frontend expects for a user (mirrors the old profiles row).
export function publicUser(u: Doc<"users">) {
  return {
    id: u.uid,
    email: u.email,
    full_name: u.full_name ?? null,
    role: u.role,
    is_active: u.is_active,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

// Validate a session; the definitive auth check used by every page.
export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const su = await sessionUser(ctx, token);
    if (!su) return null;
    return { user: publicUser(su.user), expires_at: su.session.expires_at };
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return { ok: true };
  },
});

/* ---- internal helpers used by the Node auth actions & HTTP actions ---- */

export const getUserWithHash = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
  },
});

export const sessionUserInternal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const su = await sessionUser(ctx, token);
    if (!su) return null;
    return {
      uid: su.user.uid,
      email: su.user.email,
      role: su.user.role,
      is_active: su.user.is_active,
    };
  },
});

export const createSession = internalMutation({
  args: { user_uid: v.string(), token: v.string() },
  handler: async (ctx, { user_uid, token }) => {
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    await ctx.db.insert("sessions", {
      token,
      user_uid,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
    // Track last sign-in on the user, like Supabase did.
    const user = await ctx.db
      .query("users")
      .withIndex("by_uid", (q) => q.eq("uid", user_uid))
      .unique();
    if (user) await ctx.db.patch(user._id, { last_sign_in_at: now.toISOString() });
    return { expires_at: expires.toISOString() };
  },
});

/* ---- brute-force lockout (replaces Supabase GoTrue's built-in limits) ---- */

const FAIL_WINDOW_MS = 15 * 60 * 1000; // count failures within 15 minutes
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export const checkLoginThrottle = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("login_attempts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!row || !row.locked_until) return { locked: false };
    return { locked: new Date(row.locked_until).getTime() > Date.now() };
  },
});

export const recordLoginFailure = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("login_attempts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!row) {
      await ctx.db.insert("login_attempts", {
        email,
        failed_count: 1,
        first_failed_at: new Date(now).toISOString(),
      });
      return;
    }
    const windowStart = new Date(row.first_failed_at).getTime();
    const lockedUntil = row.locked_until
      ? new Date(row.locked_until).getTime()
      : 0;
    if (now - windowStart > FAIL_WINDOW_MS && now > lockedUntil) {
      // Stale window and no active lock: start counting afresh.
      await ctx.db.patch(row._id, {
        failed_count: 1,
        first_failed_at: new Date(now).toISOString(),
        locked_until: undefined,
      });
      return;
    }
    const count = row.failed_count + 1;
    await ctx.db.patch(row._id, {
      failed_count: count,
      locked_until:
        count >= MAX_FAILS
          ? new Date(now + LOCK_MS).toISOString()
          : row.locked_until,
    });
  },
});

export const clearLoginFailures = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("login_attempts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

// Insert a user. `role` is set by the admin-invite flow (adminCreateUser);
// it defaults to 'viewer' and only ever resolves to 'viewer' or 'admin'.
export const createUser = internalMutation({
  args: {
    uid: v.string(),
    email: v.string(),
    full_name: v.string(),
    password_hash: v.string(),
    role: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (existing) return { ok: false as const, error: "exists" as const };
    const now = new Date().toISOString();
    await ctx.db.insert("users", {
      uid: args.uid,
      email: args.email,
      full_name: args.full_name,
      role: args.role === "admin" ? "admin" : "viewer",
      is_active: true,
      password_hash: args.password_hash,
      created_at: now,
      updated_at: now,
      email_confirmed_at: now,
    });
    return { ok: true as const };
  },
});
