// Dashboard data files (converted_data_latest.json, BOQ-IDB.json) stored in
// Convex file storage and served by the /assets/<name> HTTP route.
import {
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const getByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db
      .query("assets")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
  },
});

export const upsert = internalMutation({
  args: {
    name: v.string(),
    storage_id: v.id("_storage"),
    content_type: v.string(),
  },
  handler: async (ctx, { name, storage_id, content_type }) => {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    const now = new Date().toISOString();
    if (existing) {
      // Free the superseded file before pointing at the new one.
      await ctx.storage.delete(existing.storage_id);
      await ctx.db.patch(existing._id, {
        storage_id,
        content_type,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("assets", {
        name,
        storage_id,
        content_type,
        updated_at: now,
      });
    }
    return { ok: true };
  },
});

// One-shot migration/refresh: pull the data files from URLs into storage.
// Run with:  npx convex run --prod assets:importFromUrls '{"sources": [...]}'
// (defaults to the legacy Supabase public bucket URLs when omitted).
const DEFAULT_SOURCES = [
  {
    name: "converted_data_latest.json",
    url: "https://mvfguayhttcdeibomjru.supabase.co/storage/v1/object/public/dashboard-assets/converted_data_latest.json",
  },
  {
    name: "BOQ-IDB.json",
    url: "https://mvfguayhttcdeibomjru.supabase.co/storage/v1/object/public/dashboard-assets/BOQ-IDB.json",
  },
];

export const importFromUrls = internalAction({
  args: {
    sources: v.optional(
      v.array(v.object({ name: v.string(), url: v.string() }))
    ),
  },
  handler: async (ctx, { sources }) => {
    const list = sources ?? DEFAULT_SOURCES;
    const results: Array<{ name: string; ok: boolean; bytes?: number; error?: string }> = [];
    for (const src of list) {
      try {
        const res = await fetch(src.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const storage_id = await ctx.storage.store(blob);
        await ctx.runMutation(internal.assets.upsert, {
          name: src.name,
          storage_id,
          content_type: "application/json",
        });
        results.push({ name: src.name, ok: true, bytes: blob.size });
      } catch (e) {
        results.push({
          name: src.name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  },
});
