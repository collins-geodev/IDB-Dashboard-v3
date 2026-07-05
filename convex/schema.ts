import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Field names deliberately mirror the original Supabase (snake_case) columns
// so the static frontend needs minimal changes. `uid` is the stable user id:
// the legacy Supabase auth.users uuid for migrated users, a fresh uuid for
// users created after the migration.
export default defineSchema({
  users: defineTable({
    uid: v.string(),
    email: v.string(), // stored lowercase
    full_name: v.optional(v.string()),
    role: v.string(), // 'viewer' | 'admin'
    is_active: v.boolean(),
    password_hash: v.string(), // bcrypt ($2a$/$2b$)
    created_at: v.string(), // ISO timestamps, matching the old columns
    updated_at: v.string(),
    last_sign_in_at: v.optional(v.string()),
    email_confirmed_at: v.optional(v.string()),
  })
    .index("by_uid", ["uid"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    token: v.string(),
    user_uid: v.string(),
    created_at: v.string(),
    expires_at: v.string(),
  })
    .index("by_token", ["token"])
    .index("by_user", ["user_uid"]),

  audit_logs: defineTable({
    legacy_id: v.optional(v.string()), // original Supabase row id
    user_id: v.optional(v.string()), // users.uid (kept null-ish for deleted users)
    email: v.optional(v.string()),
    event_type: v.string(),
    ip_address: v.optional(v.string()),
    city: v.optional(v.string()),
    region: v.optional(v.string()),
    country: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    isp: v.optional(v.string()),
    user_agent: v.optional(v.string()),
    browser: v.optional(v.string()),
    os: v.optional(v.string()),
    device_type: v.optional(v.string()),
    screen_resolution: v.optional(v.string()),
    language: v.optional(v.string()),
    timezone: v.optional(v.string()),
    referrer: v.optional(v.string()),
    page: v.optional(v.string()),
    session_id: v.optional(v.string()),
    login_at: v.string(),
    last_seen_at: v.optional(v.string()),
    logout_at: v.optional(v.string()),
    duration_seconds: v.optional(v.number()),
    extra: v.optional(v.any()),
    created_at: v.string(),
  })
    .index("by_login_at", ["login_at"])
    .index("by_user", ["user_id"]),

  // Failed sign-in tracking for brute-force lockout (per email).
  login_attempts: defineTable({
    email: v.string(),
    failed_count: v.number(),
    first_failed_at: v.string(),
    locked_until: v.optional(v.string()),
  }).index("by_email", ["email"]),

  // Large dashboard data files (converted_data_latest.json, BOQ-IDB.json)
  // served via the /assets/<name> HTTP action.
  assets: defineTable({
    name: v.string(),
    storage_id: v.id("_storage"),
    content_type: v.string(),
    updated_at: v.string(),
  }).index("by_name", ["name"]),
});
