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
 * We deliberately keep the event vocabulary tiny and typed: `signup` (a barber
 * created an account) and `purchase` (a paid subscription started). Those are
 * the two conversions ad platforms optimize toward.
 */

type TrackEvent = "signup" | "purchase";

// Map our internal event names to Meta's standard event names so Meta can
// optimize campaigns against them. PostHog just receives our own name.
const META_STANDARD_EVENT: Record<TrackEvent, string> = {
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
    window.fbq?.("track", META_STANDARD_EVENT[event], props);
  } catch {
    /* a broken pixel must never break the page */
  }
  try {
    window.posthog?.capture(event, props);
  } catch {
    /* same */
  }
}
