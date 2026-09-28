// عطورنا — Cloudflare Worker.
// Serves the built app (static assets) and a tiny /api/push/* API that
// delivers real phone notifications (Web Push) — they arrive even when the
// app is fully closed. Only /api/* reaches this code (see run_worker_first
// in wrangler.toml); every other request is served straight from ./dist.
//
// Needs:
//   VAPID_PUBLIC_KEY  — plain variable (in wrangler.toml)
//   VAPID_PRIVATE_KEY — SECRET, set once in the Cloudflare dashboard
//                       (Settings → Variables and Secrets)

import { sendWebPush } from "./webpush.js";

// Addresses the app may be opened from — they're allowed to call this API.
// (atourna.pages.dev has no Worker of its own, so it calls this one.)
const ALLOWED_ORIGIN = /^https:\/\/(([a-z0-9-]+\.)?atourna\.pages\.dev|atourna\.adnanalbrahim90\.workers\.dev)$/;

const corsHeaders = (origin) =>
  origin && ALLOWED_ORIGIN.test(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};

const makeJson = (cors) => (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });

const isSubscription = (s) =>
  s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get("Origin");
    const cors = url.pathname.startsWith("/api/") ? corsHeaders(reqOrigin) : {};
    const json = makeJson(cors); // per-request, so concurrent requests never share headers

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/push/key") {
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
        return json({ error: "push-not-configured" }, 503);
      }
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === "/api/push/send" && request.method === "POST") {
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ error: "push-not-configured" }, 503);

      // Only the app itself (same site) may trigger notifications.
      if (reqOrigin && reqOrigin !== url.origin && !ALLOWED_ORIGIN.test(reqOrigin)) return json({ error: "forbidden" }, 403);

      let body;
      try { body = await request.json(); } catch { return json({ error: "bad-json" }, 400); }
      const subs = Array.isArray(body?.subscriptions) ? body.subscriptions.filter(isSubscription).slice(0, 20) : [];
      const p = body?.payload || {};
      const payload = {
        title: String(p.title || "عطورنا").slice(0, 120),
        body: String(p.body || "").slice(0, 400),
        tag: String(p.tag || "").slice(0, 80) || undefined,
        url: "/",
      };

      const options = {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT || url.origin,
      };
      const results = await Promise.all(
        subs.map((s) =>
          sendWebPush(s, payload, options).then(
            (r) => ({ endpoint: s.endpoint, ...r }),
            (e) => ({ endpoint: s.endpoint, ok: false, status: 0, gone: false, error: String(e?.message || e) })
          )
        )
      );
      return json({
        sent: results.filter((r) => r.ok).length,
        expired: results.filter((r) => r.gone).map((r) => r.endpoint),
        failed: results.filter((r) => !r.ok && !r.gone).map((r) => ({ status: r.status, error: r.error })),
      });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not-found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
