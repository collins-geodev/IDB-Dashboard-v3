// HTTP endpoints (served from https://<deployment>.convex.site):
//   POST /log-event           records a login footprint with the REAL client IP
//                             (from request headers) + server-side geo lookup.
//   GET  /assets/<name>       serves the dashboard data files from file storage.
//   POST /admin/upload-asset  ADMIN-ONLY: replaces a dashboard data file
//                             (converted_data_latest.json / BOQ-IDB.json) in
//                             file storage from an uploaded JSON body. Used by
//                             the dashboard's "Update Data (JSON)" control.
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clientIP(req: Request): string | null {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return h.get("x-real-ip") || h.get("cf-connecting-ip") || null;
}

async function geo(ip: string | null) {
  if (!ip) return {};
  // private/loopback ranges won't resolve
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) {
    return {};
  }
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const d = await r.json();
    if (d && d.success !== false) {
      return {
        city: d.city || null,
        region: d.region || null,
        country: d.country || null,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        isp: (d.connection && (d.connection.isp || d.connection.org)) || null,
      };
    }
  } catch (_) {
    /* fall through */
  }
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`);
    const d = await r.json();
    if (d && !d.error) {
      return {
        city: d.city || null,
        region: d.region || null,
        country: d.country_name || null,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        isp: d.org || null,
      };
    }
  } catch (_) {
    /* give up */
  }
  return {};
}

const http = httpRouter();

http.route({
  path: "/log-event",
  method: "OPTIONS",
  handler: httpAction(async () => new Response("ok", { headers: corsHeaders })),
});

http.route({
  path: "/log-event",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const token = (req.headers.get("Authorization") || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
      if (!token) return json({ error: "Missing token" }, 401);
      const su = await ctx.runQuery(internal.auth.sessionUserInternal, {
        token,
      });
      if (!su) return json({ error: "Invalid session" }, 401);

      const body = await req.json().catch(() => ({}));
      const ip = clientIP(req);
      const g = await geo(ip);
      const id = await ctx.runMutation(internal.audit.insertLog, {
        uid: su.uid,
        email: su.email,
        body: {
          ...body,
          user_agent: body.user_agent || req.headers.get("user-agent"),
          language: body.language || req.headers.get("accept-language"),
        },
        ip_address: ip ?? undefined,
        geo: g,
      });
      return json({ id, ip, geo: g });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }),
});

http.route({
  pathPrefix: "/assets/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response("ok", { headers: corsHeaders })),
});

http.route({
  pathPrefix: "/assets/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const name = decodeURIComponent(url.pathname.replace(/^\/assets\//, ""));
    if (!name) return json({ error: "Missing asset name" }, 400);
    const asset = await ctx.runQuery(internal.assets.getByName, { name });
    if (!asset) return json({ error: "Not found" }, 404);
    const blob = await ctx.storage.get(asset.storage_id);
    if (!blob) return json({ error: "Not found" }, 404);
    return new Response(blob, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": asset.content_type,
        "Cache-Control": "public, max-age=300",
      },
    });
  }),
});

// ── Admin-only data upload ────────────────────────────────────────────────
// Replaces a canonical dashboard data file in Convex file storage from an
// uploaded JSON body, so the change is persisted and served to EVERY viewer.
// The per-dashboard feeder allowlist ("the configuration") is applied on the
// client at load time (script.js), so an uploaded full dataset is automatically
// scoped to this dashboard. Only these file names may be written.
const UPLOADABLE_ASSETS = new Set([
  "converted_data_latest.json",
  "BOQ-IDB.json",
]);

http.route({
  path: "/admin/upload-asset",
  method: "OPTIONS",
  handler: httpAction(async () => new Response("ok", { headers: corsHeaders })),
});

http.route({
  path: "/admin/upload-asset",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      // 1. Authenticate the caller and require an ACTIVE ADMIN. This is the
      //    authoritative check — the UI gate is convenience only.
      const token = (req.headers.get("Authorization") || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
      if (!token) return json({ ok: false, error: "Missing session token." }, 401);
      const su = await ctx.runQuery(internal.auth.sessionUserInternal, { token });
      if (!su) return json({ ok: false, error: "Invalid or expired session." }, 401);
      if (su.is_active === false) {
        return json({ ok: false, error: "Your account is inactive." }, 403);
      }
      if (su.role !== "admin") {
        return json(
          { ok: false, error: "Only administrators can update the dashboard data." },
          403
        );
      }

      // 2. Resolve and validate the target asset name (strict allowlist).
      const url = new URL(req.url);
      const name = decodeURIComponent((url.searchParams.get("name") || "").trim());
      if (!name) return json({ ok: false, error: "Missing asset name." }, 400);
      if (!UPLOADABLE_ASSETS.has(name)) {
        return json({ ok: false, error: `"${name}" is not an updatable data file.` }, 400);
      }

      // 3. Read and validate the body: must parse as JSON and yield at least
      //    one record (either a bare array, or an object wrapping one).
      const text = await req.text();
      if (!text || !text.trim()) {
        return json({ ok: false, error: "The uploaded file is empty." }, 400);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ ok: false, error: "The uploaded file is not valid JSON." }, 400);
      }
      let records: unknown[] = [];
      if (Array.isArray(parsed)) {
        records = parsed;
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const arr = (obj.Sheet2 ||
          obj.Sheet1 ||
          Object.values(obj).find((v) => Array.isArray(v))) as unknown[] | undefined;
        records = Array.isArray(arr) ? arr : [];
      }
      if (!records.length) {
        return json(
          {
            ok: false,
            error:
              "The JSON contains no records. Expected an array of row objects (or an object whose value is such an array).",
          },
          400
        );
      }

      // 4. Store the new file and repoint the assets row (frees the old file).
      const blob = new Blob([text], { type: "application/json" });
      const storage_id = await ctx.storage.store(blob);
      await ctx.runMutation(internal.assets.upsert, {
        name,
        storage_id,
        content_type: "application/json",
      });

      // 5. Best-effort audit entry (never blocks the upload result).
      try {
        await ctx.runMutation(internal.audit.insertLog, {
          uid: su.uid,
          email: su.email,
          body: {
            event_type: "data_upload",
            page: "index.html",
            extra: { asset: name, records: records.length, bytes: blob.size },
          },
          ip_address: clientIP(req) ?? undefined,
          geo: {},
        });
      } catch (_) {
        /* audit is non-critical */
      }

      return json({ ok: true, name, records: records.length, bytes: blob.size });
    } catch (e) {
      return json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        500
      );
    }
  }),
});

export default http;
