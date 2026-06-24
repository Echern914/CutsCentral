/* ChairBack rewards PWA service worker.
 *
 * Hand-written (no next-pwa/serwist) so it stays small and auditable under the
 * strict CSP. Served at /sw.js with default root scope, so it controls every
 * /r/<magicToken> rewards page. Registered LAZILY by PushOptIn after the client
 * grants notification permission - a customer who never opts in never gets a SW.
 *
 * Responsibilities, all push-related:
 *  - take control fast (skipWaiting + clients.claim) so an updated worker wins
 *  - render an incoming push (push event -> showNotification)
 *  - route a click to the rewards/booking URL (notificationclick)
 *  - best-effort re-subscribe when the browser rotates the subscription
 *    (pushsubscriptionchange), using the VAPID key + token cached by the page
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A push arrived. The payload is the JSON our API sends:
// { title, body, url, tag? }. Fall back to a generic notification if the payload
// is missing/unparseable so a malformed send still surfaces something.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  const title = data.title || "ChairBack";
  const options = {
    body: data.body || "",
    // App-provided icons live in /public; absolute paths resolve against origin.
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    // The click target travels in the notification data so notificationclick can read it.
    data: { url: data.url || "/" },
    // Collapse re-sends of the same kind (e.g. "rebook") instead of stacking.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// The customer tapped the notification: focus an existing tab on that URL if one
// is open, else open a new window. Matching by URL prefix keeps a single rewards
// tab in focus rather than spawning duplicates.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          // Same-origin tab already showing the rewards page: just focus it.
          if ("focus" in client && client.url.includes("/r/")) {
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

// The browser rotated/expired the push subscription. Best-effort re-subscribe and
// re-register with our API using the VAPID key + magicToken the page cached after
// the first subscribe (see PushOptIn). Browsers vary in support; on failure the
// page re-subscribes on the customer's next visit anyway.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open("push-config-v1");
        const res = await cache.match("/__push_config");
        if (!res) return;
        const cfg = await res.json(); // { token, vapidPublicKey }
        if (!cfg.token || !cfg.vapidPublicKey) return;

        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
        });
        const json = sub.toJSON();
        await fetch(`/r/${cfg.token}/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
            userAgent: self.navigator ? self.navigator.userAgent : undefined,
          }),
        });
      } catch (_e) {
        // Swallow: re-subscription is best-effort. No customer-visible failure.
      }
    })(),
  );
});

// VAPID public keys are base64url; the Push API wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
