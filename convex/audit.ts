// Audit-trail writes: insert on login (via the /log-event HTTP action or the
// client fallback), heartbeat/logout patches while a session is active.
import { mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { sessionUser } from "./auth";

// Only these client-supplied fields are accepted on an audit row.
const CLIENT_FIELDS = [
  "event_type",
  "user_agent",
  "browser",
  "os",
  "device_type",
  "screen_resolution",
  "language",
  "timezone",
  "referrer",
  "page",
  "session_id",
  "extra",
] as const;

function pickClientFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of CLIENT_FIELDS) {
    if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  }
  if (typeof out.event_type !== "string" || !out.event_type) {
    out.event_type = "login";
  }
  return out;
}

export const insertLog = internalMutation({
  args: {
    uid: v.string(),
    email: v.string(),
    body: v.any(),
    ip_address: v.optional(v.string()),
    geo: v.optional(v.any()),
  },
  handler: async (ctx, { uid, email, body, ip_address, geo }) => {
    const now = new Date().toISOString();
    const g = (geo ?? {}) as Record<string, unknown>;
    const id = await ctx.db.insert("audit_logs", {
      user_id: uid,
      email,
      ...(pickClientFields(body ?? {}) as any),
      event_type:
        typeof body?.event_type === "string" && body.event_type
          ? body.event_type
          : "login",
      ip_address: ip_address ?? undefined,
      city: (g.city as string) ?? undefined,
      region: (g.region as string) ?? undefined,
      country: (g.country as string) ?? undefined,
      latitude: typeof g.latitude === "number" ? g.latitude : undefined,
      longitude: typeof g.longitude === "number" ? g.longitude : undefined,
      isp: (g.isp as string) ?? undefined,
      login_at: now,
      created_at: now,
    });
    return id;
  },
});

// Fallback used when the /log-event HTTP action is unreachable (no IP/geo).
export const clientInsert = mutation({
  args: { token: v.string(), payload: v.any() },
  handler: async (ctx, { token, payload }) => {
    const su = await sessionUser(ctx, token);
    if (!su) return { ok: false, error: "Invalid session" };
    const now = new Date().toISOString();
    const id = await ctx.db.insert("audit_logs", {
      user_id: su.user.uid,
      email: su.user.email,
      ...(pickClientFields(payload ?? {}) as any),
      login_at: now,
      created_at: now,
    });
    return { ok: true, id };
  },
});

// Heartbeat / logout finalisation. Only the owner of the row may patch it,
// and only the three session-lifecycle fields.
export const patchLog = mutation({
  args: {
    token: v.string(),
    log_id: v.string(),
    last_seen_at: v.optional(v.string()),
    logout_at: v.optional(v.string()),
    duration_seconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const su = await sessionUser(ctx, args.token);
    if (!su) return { ok: false, error: "Invalid session" };
    const logId = ctx.db.normalizeId("audit_logs", args.log_id);
    if (!logId) return { ok: false, error: "Invalid log id" };
    const log = await ctx.db.get(logId);
    if (!log || log.user_id !== su.user.uid) {
      return { ok: false, error: "Not found" };
    }
    const patch: Record<string, unknown> = {};
    if (args.last_seen_at !== undefined) patch.last_seen_at = args.last_seen_at;
    if (args.logout_at !== undefined) patch.logout_at = args.logout_at;
    if (args.duration_seconds !== undefined) {
      patch.duration_seconds = args.duration_seconds;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(logId, patch);
    return { ok: true };
  },
});
