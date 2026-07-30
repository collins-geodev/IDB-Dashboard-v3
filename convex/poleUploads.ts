// Shared "New-Pole template upload" store.
//
// Poles the admin uploads via the dashboard's New-Pole Template → Upload action
// land here and are served to EVERY viewer (the frontend merges them with the
// canonical converted_data_latest.json client-side). Keeping them in their own
// table means the weekly data refresh (assets:importFromUrls) never disturbs
// them, and a matching Lt PoleSLRN in a later official export simply de-dupes
// client-side.
//
// Reads are public (anyone viewing the dashboard sees them). Writes are
// ADMIN-ONLY — enforced here on the server, not just in the UI.
import { query, mutation, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { sessionUser } from "./auth";

// Public: list every shared uploaded pole record (the raw objects the
// dashboard renders). No auth required — viewing is open to all users.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pole_uploads").collect();
    return rows.map((r) => r.record);
  },
});

// Resolve the caller to an active admin, or throw a clear error.
async function requireAdmin(ctx: MutationCtx, token: string | null | undefined) {
  const su = await sessionUser(ctx, token);
  if (!su) throw new Error("Please sign in to publish uploaded poles.");
  if (su.user.is_active === false) throw new Error("Your account is inactive.");
  if (su.user.role !== "admin") {
    throw new Error("Only administrators can publish or remove uploaded poles.");
  }
  return su.user;
}

// Admin only: add/upsert a batch of already-normalized pole records. Records
// carrying an Lt PoleSLRN are upserted by that key (no duplicates); records
// still awaiting GIS capture (no SLRN) are appended.
export const addMany = mutation({
  args: {
    token: v.string(),
    records: v.array(v.any()),
  },
  handler: async (ctx, { token, records }) => {
    const admin = await requireAdmin(ctx, token);
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    let pending = 0;
    for (const rec of records) {
      const slrn = String((rec && rec["Lt PoleSLRN"]) || "")
        .trim()
        .toLowerCase();
      if (slrn) {
        const existing = await ctx.db
          .query("pole_uploads")
          .withIndex("by_slrn", (q) => q.eq("slrn", slrn))
          .unique();
        if (existing) {
          await ctx.db.patch(existing._id, {
            record: rec,
            uploaded_by: admin.email,
            updated_at: now,
          });
          updated++;
        } else {
          await ctx.db.insert("pole_uploads", {
            slrn,
            record: rec,
            uploaded_by: admin.email,
            created_at: now,
          });
          added++;
        }
      } else {
        await ctx.db.insert("pole_uploads", {
          slrn: "",
          record: rec,
          uploaded_by: admin.email,
          created_at: now,
        });
        pending++;
      }
    }
    return { added, updated, pending };
  },
});

// Admin only: remove every shared uploaded pole.
export const clearAll = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);
    const rows = await ctx.db.query("pole_uploads").collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { removed: rows.length };
  },
});
