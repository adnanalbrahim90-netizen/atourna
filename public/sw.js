// عطورنا — service worker used only to show system (phone) notifications,
// e.g. when a colleague asks you for stock. It deliberately does NOT cache
// any files, so every deploy is picked up immediately as before.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Tapping a notification brings the app to the front (or opens it); the
// in-page approve/reject popup then appears automatically.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })
  );
});

// Real server push (delivered by the site's Cloudflare Worker) — arrives
// even when the app is fully closed.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "عطورنا", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      dir: "rtl",
      lang: "ar",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
    })
  );
});
