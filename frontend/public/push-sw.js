/* Push service worker — registered on demand by lib/notifications.js.
 * Kept intentionally tiny: show the notification, focus/open the app on
 * click. No caching, no fetch interception (the SPA's own asset caching
 * strategy stays untouched). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON push */ }
  const title = data.title || "Tradermigos";
  const options = {
    body: data.body || "",
    icon: "/apple-touch-icon.png",
    badge: "/apple-touch-icon.png",
    tag: data.tag || "tradermigos",
    data: { url: data.url || "/nakamigos" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/nakamigos";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          client.navigate?.(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
