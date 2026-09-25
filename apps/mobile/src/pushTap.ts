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
  // Everything else keeps today's behaviour: the app opens where it was.
  return null;
}
