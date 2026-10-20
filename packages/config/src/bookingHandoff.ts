/**
 * The booking handoff's ride across the web pages (apps/api auth/bookingHandoff.ts
 * signs and reads it; nothing here can).
 *
 * The app opens a shop's page in a WebView with `?cb_me=<handoff>` on the URL.
 * The storefront (/r/<token>) passes it to its Book link, the booking page
 * (/book/<slug>) passes it to the booking, and the API decides what it is
 * worth. The web never inspects it beyond its shape - it is opaque, and a
 * malformed or missing one just means an ordinary, anonymous booking.
 *
 * Plain constants and string checks only: imported by client components.
 */

export const BOOKING_HANDOFF_PARAM = "cb_me";

/** base64url payload "." base64url signature - and never anything longer than a URL should carry. */
const SHAPE = /^[A-Za-z0-9_-]{16,800}\.[A-Za-z0-9_-]{16,100}$/;

/**
 * The handoff from a page's search params, or null. Accepts what Next hands a
 * page (a string, an array when the parameter repeats, or nothing) and keeps
 * only a single well-formed value: two of them is a URL someone built, not one
 * the API wrote.
 */
export function bookingHandoffFrom(value: string | string[] | undefined | null): string | null {
  if (typeof value !== "string") return null;
  return SHAPE.test(value) ? value : null;
}

/** "?cb_me=..." for a Book link, or "" when there is nothing to carry. */
export function bookingHandoffQuery(handoff: string | null): string {
  return handoff ? `?${BOOKING_HANDOFF_PARAM}=${encodeURIComponent(handoff)}` : "";
}
