// Phone-notification API (Web Push) for عطورنا, served by Cloudflare Pages
// Functions on the same address as the app (atourna.pages.dev).
//
// Needs ONE secret in the Pages project:
//   VAPID_PRIVATE_KEY — Settings → Variables and Secrets → Add → Type: Secret
// The public half of the key pair is not secret and lives here.

import { sendWebPush } from "./webpush.js";

export const VAPID_PUBLIC_KEY = "BC_grHH_KA2Kd-DX2JZxrRPci7GOQsXeeOFUe7f3jpISgG5-4cwwr9XlCxAu7TzKcb1CuLlIYweJdVckamVrlEY";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const isSubscription = (s) =>
  s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";

export function handleKey(env) {
  if (!env.VAPID_PRIVATE_KEY) return json({ error: "push-not-configured" }, 503);
  return json({ publicKey: VAPID_PUBLIC_KEY });
}

export async function handleSend(request, env) {
  if (!env.VAPID_PRIVATE_KEY) return json({ error: "push-not-configured" }, 503);

  // Only the app itself (same site, or one of its preview addresses) may send.
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin && !/^https:\/\/([a-z0-9-]+\.)?atourna\.pages\.dev$/.test(origin)) {
    return json({ error: "forbidden" }, 403);
  }

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

  const options = { publicKey: VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || url.origin };
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
