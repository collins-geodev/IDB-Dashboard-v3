"use node";
// Password sign-in / sign-up. Runs in the Node runtime so we can verify the
// bcrypt hashes migrated from Supabase auth (users keep their old passwords).
import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

function newToken(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const signIn = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    // Brute-force lockout: too many recent failures for this email.
    const throttle = await ctx.runQuery(internal.auth.checkLoginThrottle, {
      email,
    });
    if (throttle.locked) {
      return {
        ok: false,
        error:
          "Too many failed sign-in attempts. Please try again in about 15 minutes.",
      };
    }
    const user = await ctx.runQuery(internal.auth.getUserWithHash, { email });
    // Same generic message for unknown email and wrong password.
    if (!user) {
      await ctx.runMutation(internal.auth.recordLoginFailure, { email });
      return { ok: false, error: "Invalid email or password." };
    }
    const match = await bcrypt.compare(args.password, user.password_hash);
    if (!match) {
      await ctx.runMutation(internal.auth.recordLoginFailure, { email });
      return { ok: false, error: "Invalid email or password." };
    }
    await ctx.runMutation(internal.auth.clearLoginFailures, { email });
    if (user.is_active === false) {
      return {
        ok: false,
        code: "user_deactivated",
        error:
          "Your account has been deactivated. Please contact an administrator.",
      };
    }
    const token = newToken();
    const res = await ctx.runMutation(internal.auth.createSession, {
      user_uid: user.uid,
      token,
    });
    return {
      ok: true,
      token,
      expires_at: res.expires_at,
      user: {
        id: user.uid,
        email: user.email,
        full_name: user.full_name ?? null,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    };
  },
});

// Admin-invite-only account creation. There is intentionally NO public
// self-service signup: the dashboard is a private internal tool, so only an
// existing active admin can create accounts (this replaces the old public
// signUp action / signup-viewer edge function). No session is minted here —
// the admin creates the account and shares the initial password.
export const adminCreateUser = action({
  args: {
    token: v.string(),
    email: v.string(),
    password: v.string(),
    full_name: v.optional(v.string()),
    role: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Authorize: caller's session must resolve to an active admin.
    const caller = await ctx.runQuery(internal.auth.sessionUserInternal, {
      token: args.token,
    });
    if (!caller || caller.role !== "admin" || caller.is_active === false) {
      return { ok: false, error: "Forbidden: administrator access required" };
    }

    const email = args.email.trim().toLowerCase();
    const fullName = (args.full_name ?? "").trim() || email.split("@")[0];
    const role = args.role === "admin" ? "admin" : "viewer";
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: "Please enter a valid email address." };
    }
    if (args.password.length < 6) {
      return { ok: false, error: "Password must be at least 6 characters." };
    }

    const password_hash = await bcrypt.hash(args.password, 10);
    const uid = randomUUID();
    const created = await ctx.runMutation(internal.auth.createUser, {
      uid,
      email,
      full_name: fullName,
      password_hash,
      role,
    });
    if (!created.ok) {
      return { ok: false, error: "An account with this email already exists." };
    }
    return { ok: true, email, full_name: fullName, role };
  },
});

// Self-service password change for a signed-in user. Requires the current
// password (so an admin-created default password can be replaced by the user).
export const changePassword = action({
  args: {
    token: v.string(),
    current_password: v.string(),
    new_password: v.string(),
  },
  handler: async (ctx, args) => {
    const su = await ctx.runQuery(internal.auth.sessionUserInternal, {
      token: args.token,
    });
    if (!su) {
      return {
        ok: false,
        error: "Your session has expired. Please sign in again.",
      };
    }
    if (args.new_password.length < 6) {
      return { ok: false, error: "New password must be at least 6 characters." };
    }
    if (args.current_password === args.new_password) {
      return {
        ok: false,
        error: "New password must be different from the current one.",
      };
    }
    const user = await ctx.runQuery(internal.auth.getUserWithHash, {
      email: su.email,
    });
    if (!user) return { ok: false, error: "Account not found." };
    const match = await bcrypt.compare(
      args.current_password,
      user.password_hash
    );
    if (!match) {
      return { ok: false, error: "Your current password is incorrect." };
    }
    const password_hash = await bcrypt.hash(args.new_password, 10);
    await ctx.runMutation(internal.auth.updatePasswordHash, {
      uid: su.uid,
      password_hash,
    });
    return { ok: true };
  },
});
