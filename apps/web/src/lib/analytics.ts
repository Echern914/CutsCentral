/**
 * Thin analytics facade. Two sinks, BOTH optional and env-gated so nothing loads
 * (and nothing here does anything) until the corresponding env var is set:
 *
 *   - Meta Pixel  — window.fbq, loaded when NEXT_PUBLIC_META_PIXEL_ID is set.
 *   - PostHog     — window.posthog, loaded when NEXT_PUBLIC_POSTHOG_KEY is set.
 *
 * Both are bootstrapped by lightweight inline snippets in <AnalyticsScripts>
 * (no npm dependency, so no lockfile / dual-React risk). This module just calls
 * whichever globals exist. With neither configured, `track()` is a no-op — safe
 * to ship before you have any pixel IDs.
 *
 * We deliberately keep the event vocabulary tiny and typed. Two conversions ad
 * platforms optimize toward - `signup` (a barber created an account) and
 * `purchase` (a paid subscription started) - plus the three app-discovery
 * events, which are PRODUCT measurement rather than ad conversions.
 *
 * 🔴 THE APP-DISCOVERY EVENTS CARRY A SURFACE AND NOTHING ELSE. They fire on
 * public customer pages - a booking page anyone can reach by scanning a sticker
 * on a wall - so there is no identified user here to attach, and attaching one
 * would turn a "how many people tapped Get the app" counter into a record of
 * who visited which shop. `surface` ("booking" | "shop" | "manage" | "line") is
 * enough to answer every question this is for, and is not about the customer.
 */

type TrackEvent =
  | "signup"
  | "purchase"
  // The install/open card rendered. The denominator for the two below.
  | "app_banner_shown"
  // They tapped through to the App Store listing.
  | "app_store_clicked"
  // They tapped "Open in ChairBack" - a hand-off to an app we believe is there.
  | "app_opened";

/**
 * Meta's standard event names, so Meta can optimize campaigns against them.
 * PostHog always receives our own name.
 *
 * PARTIAL ON PURPOSE (`Partial<Record<...>>`): only the two conversions have a
 * Meta standard equivalent. The app-discovery events are ours; sending them to
 * Meta under an invented name would put noise in an ad account for nothing.
 */
const META_STANDARD_EVENT: Partial<Record<TrackEvent, string>> = {
  signup: "CompleteRegistration",
  purchase: "Purchase",
};

interface Fbq {
  (command: "track", event: string, params?: Record<string, unknown>): void;
}
interface PostHog {
  capture: (event: string, props?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    fbq?: Fbq;
    posthog?: PostHog;
  }
}

export function metaPixelId(): string | undefined {
  return process.env.NEXT_PUBLIC_META_PIXEL_ID || undefined;
}
export function posthogKey(): string | undefined {
  return process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined;
}
export function posthogHost(): string {
  return process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
}

/**
 * Fire a conversion event to every configured sink. Safe to call anywhere on the
 * client; no-ops when a sink isn't loaded. `props` may include a `value` (USD)
 * for purchase events, which Meta uses for value-based optimization.
 */
export function track(event: TrackEvent, props?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    // Only the events Meta has a standard name for; the rest are PostHog-only.
    const metaEvent = META_STANDARD_EVENT[event];
    if (metaEvent) window.fbq?.("track", metaEvent, props);
  } catch {
    /* a broken pixel must never break the page */
  }
  try {
    window.posthog?.capture(event, props);
  } catch {
    /* same */
  }
}
