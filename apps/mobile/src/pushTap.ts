/**
 * Where a tapped notification should land.
 *
 * Until now nothing listened for a tap: every notification just opened the app
 * wherever it was last. That is tolerable for a reminder about a booking the
 * customer already has, and wrong for an opening held for their tier - it
 * expires, and it is two taps away on a screen they have no reason to open.
 *
 * Pure on purpose: the rule is a string in, a route out, so it is tested
 * without a notification, a device or a router.
 */

/** A notification's `data`, as Expo hands it over - anything at all. */
export function routeForNotification(data: unknown): string | null {
  const url = typeof (data as { url?: unknown } | null)?.url === "string" ? (data as { url: string }).url : null;
  if (!url) return null;
  // An opening is time-critical and lives on Profile, under "Held for you".
  if (/[?&]opening=[^&]+/.test(url)) return "/customer/profile";
  // A shop's announcement (a broadcast) stays on the Announcements screen
  // after the notification is swiped away - that is where the tap goes.
  if (/[?&]announcement=[^&]+/.test(url)) return "/customer/announcements";
  // A BARBER alert ("Next up: ...", a new booking, a cancellation) links to a
  // dashboard page - usually one appointment. A barber, 2026-09-29: "when I tap
  // a notification it should take me directly to that day and time's
  // appointment". The server has sent that link all along; nothing here read
  // it. The barber screen opens the WebView at it.
  const dashboard = dashboardPathOf(url);
  if (dashboard) return `/barber?next=${encodeURIComponent(dashboard)}`;
  // Everything else keeps today's behaviour: the app opens where it was.
  return null;
}

/**
 * The dashboard path (+ query) of a link, or null if it is not one.
 *
 * 🔴 ONLY THE PATH IS KEPT, and only under /dashboard. The barber screen puts
 * it after ITS OWN origin, so a notification can never point the signed-in
 * WebView at another site. A regex rather than `new URL`, because React
 * Native's URL does not implement `pathname`/`search`.
 */
export function dashboardPathOf(url: string): string | null {
  const m = /^https?:\/\/[^/?#\\]+(\/dashboard(?:\/[^?#\s\\]*)?(?:\?[^#\s\\]*)?)(?:#.*)?$/.exec(url);
  return m ? safeDashboardPath(m[1]!) : null;
}

/**
 * A `next` path the barber screen may open: same-origin, under /dashboard, no
 * "//" (which a browser reads as another host). Anything else is null.
 */
export function safeDashboardPath(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  if (!/^\/dashboard(?:[/?]|$)/.test(path)) return null;
  if (path.includes("//") || path.includes("\\")) return null;
  return path;
}
