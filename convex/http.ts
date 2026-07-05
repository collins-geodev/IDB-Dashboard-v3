// HTTP endpoints (served from https://<deployment>.convex.site):
//   POST /log-event      records a login footprint with the REAL client IP
//                        (from request headers) + server-side geo lookup.
//   GET  /assets/<name>  serves the dashboard data files from file storage.
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

export default http;
