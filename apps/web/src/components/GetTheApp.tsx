"use client";

import { useEffect, useState } from "react";
import { MOBILE_APP } from "@chairback/config/constants";
import { track } from "@/lib/analytics";

/**
 * "Get the app" / "Open in ChairBack" for the PUBLIC customer surfaces - the
 * booking page, the shop mini-site, manage-a-booking and the walk-in line.
 *
 * Most customers reach these by scanning a QR code or tapping a texted link, on
 * a phone, in a browser. That is exactly the moment the app is worth offering:
 * they are already holding the thing it installs onto.
 *
 * 🔴 THE STORE URL IS A CONSTANT, NOT AN ENV VAR, and that is the whole point
 * of this file existing. The rewards-page banner read `process.env.APP_STORE_URL`
 * and treated "unset" as "the app isn't live yet, stay quiet". The variable was
 * never added to Vercel, so the banner never rendered once in production while
 * the App Store listing had been live for weeks - a growth feature switched off
 * by an absence nobody could see. The listing id is stable and already lives in
 * config; reading it from there cannot fail closed.
 *
 * 🔴 IT NOW RENDERS IN iOS SAFARI, WHICH IT USED TO REFUSE TO DO. The old rule
 * was "Safari has Apple's Smart App Banner, so stand down" - and that reasoning
 * had a hole big enough to swallow the whole feature: a QR code scanned with the
 * iPhone CAMERA opens in Safari. Safari was not the edge case, it was the main
 * path, and on it this component rendered nothing at all. What customers were
 * left with was Apple's banner alone, which is dismissible ONCE, per domain,
 * forever - so a customer who ever swiped it away never saw an install
 * affordance again on any shop's page.
 *
 * The two can briefly sit together on a first visit. That is a small cosmetic
 * cost, bounded by our own dismissal, and it buys back the case that actually
 * matters: every visit after the first one.
 *
 * Renders NOTHING when:
 *   - we are inside the native app already (the react-native-webview bridge) -
 *     they have it, so do not nag;
 *   - we are not on iOS (see the Android note below);
 *   - the customer dismissed it before, remembered per device.
 *
 * 🔴 ANDROID GETS NOTHING, DELIBERATELY. There is no Play Store listing: every
 * eas.json build and submit profile is iOS-only, and app.config.ts still carries
 * versionCode 1. The rewards banner "supported" Android by falling back to the
 * iOS App Store link, which on an Android phone opens a page the customer
 * cannot install from - worse than silence, because it looks like the product
 * is broken rather than unavailable. When an Android build ships, add
 * `playStoreUrl` to MOBILE_APP and widen the platform gate below; nothing else
 * here needs to change.
 */

const DISMISS_KEY = "cb_get_app_dismissed";

/**
 * Which page is asking, so the pitch matches what they came here to do - and
 * so the three analytics events can tell these surfaces apart. `confirmation`
 * is deliberately NOT folded into `manage`: they are the same booking but very
 * different moments, and "how many people installed right after booking" is
 * the number this whole feature gets judged by.
 */
export type AppBannerSurface =
  | "booking"
  | "confirmation"
  | "shop"
  | "manage"
  | "line";

const copyFor = (
  /** The shop's word for a visit. Neutral default: this renders on public
   *  pages that may not know the business type yet. */
  serviceNoun: string,
): Record<AppBannerSurface, { headline: string; body: string }> => ({
  booking: {
    headline: "Book faster next time",
    body: `Save your details, rebook in two taps, and get a reminder before your ${serviceNoun}.`,
  },
  confirmation: {
    headline: "Keep this appointment in your pocket",
    body: `Reschedule in a tap, get a reminder before your ${serviceNoun}, and rebook next time in two.`,
  },
  shop: {
    headline: "Keep this shop in your pocket",
    body: "Book, track your rewards and see what's open - without hunting for the link.",
  },
  manage: {
    headline: "Manage bookings in the app",
    body: `Reschedule or cancel in a tap, and get a reminder before your ${serviceNoun}.`,
  },
  line: {
    headline: "Watch your place in line",
    body: "Get a push the moment they're ready, instead of watching this page.",
  },
});

function isInNativeApp(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as { ReactNativeWebView?: unknown }).ReactNativeWebView)
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function GetTheApp({
  surface,
  serviceNoun = "visit",
  openPath,
}: {
  surface: AppBannerSurface;
  /**
   * The shop word for a visit. NEUTRAL default on purpose: this banner renders
   * on public pages that may not know the business type, and "visit" is right
   * for every vertical where a guess would be wrong for most.
   */
  serviceNoun?: string;
  /**
   * The in-app destination for THIS page, as a site-relative path - normally
   * the page's own (`/book/<slug>`). Given one, the card offers "Open in
   * ChairBack" beside the install button, and the hand-off preserves the
   * booking context: app/+native-intent.tsx forwards the tail verbatim, so a
   * ?service=/?staff= prefill survives.
   *
   * Omitted (the mini-site, the line) the card is install-only rather than
   * guessing at a route the app may not have.
   */
  openPath?: string;
}) {
  // Gated entirely on the client: userAgent, the RN bridge and localStorage are
  // browser-only, and rendering this on the server would hand the client a
  // banner it then removes - a hydration mismatch on a customer's first paint.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isInNativeApp()) return;
    if (!isIos()) return; // no Android listing to send anyone to
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private mode / storage blocked: showing it once is the friendlier miss */
    }
    setShow(true);
    // The denominator for the two tap events. Surface only - see lib/analytics.
    track("app_banner_shown", { surface });
  }, [surface]);

  if (!show) return null;
  const copy = copyFor(serviceNoun)[surface];

  /**
   * 🔴 A CUSTOM SCHEME, NOT THE https UNIVERSAL LINK, and only for this button.
   * iOS does not honour a universal link when the tap comes from a page on the
   * SAME domain - it treats that as "this person chose to stay in the browser"
   * - so an https://getchairback.com/book/... href here would reload the page
   * the customer is already looking at and nothing else. The scanned QR code
   * still arrives over the verified https link; this is the in-page fallback
   * for someone who is already in Safari.
   *
   * The scheme is unverified - any app on the device could claim it - so this
   * hands over NOTHING worth stealing: a shop slug that is already public in
   * the address bar above it, and never a token or a session.
   */
  const openUrl = openPath ? `${MOBILE_APP.scheme}:/${openPath}` : null;

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* non-fatal: it reappears next visit, which is not worth failing over */
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/60 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-offwhite">{copy.headline}</p>
          <p className="mt-1 text-sm text-muted">{copy.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {openUrl && (
              <a
                className="inline-flex min-h-11 items-center rounded-full bg-gold px-5 font-semibold text-charcoal-900"
                href={openUrl}
                onClick={() => track("app_opened", { surface })}
              >
                Open in ChairBack
              </a>
            )}
            <a
              className={
                openUrl
                  ? "inline-flex min-h-11 items-center rounded-full border border-subtle px-5 font-semibold text-offwhite"
                  : "inline-flex min-h-11 items-center rounded-full bg-gold px-5 font-semibold text-charcoal-900"
              }
              href={MOBILE_APP.appStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("app_store_clicked", { surface })}
            >
              Get the app
            </a>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
