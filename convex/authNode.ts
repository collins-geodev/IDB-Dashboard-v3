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

// Public self-service registration -> always a viewer account, immediately
// usable (mirrors the old signup-viewer edge function: no email confirmation).
export const signUp = action({
  args: {
    email: v.string(),
    password: v.string(),
    full_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const fullName = (args.full_name ?? "").trim() || email.split("@")[0];
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
    });
    if (!created.ok) {
      return {
        ok: false,
        error:
          "An account with this email already exists. Please sign in instead.",
      };
    }
    const token = newToken();
    const res = await ctx.runMutation(internal.auth.createSession, {
      user_uid: uid,
      token,
    });
    return {
      ok: true,
      token,
      expires_at: res.expires_at,
      user: {
        id: uid,
        email,
        full_name: fullName,
        role: "viewer",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    };
  },
});
