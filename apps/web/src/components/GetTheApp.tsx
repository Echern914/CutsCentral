"use client";

import { useEffect, useState } from "react";
import { MOBILE_APP } from "@chairback/config/constants";

/**
 * "Get the app" nudge for the PUBLIC customer surfaces - the booking page, the
 * shop mini-site, manage-a-booking and the walk-in line.
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
 * Renders NOTHING when:
 *   - we are inside the native app already (the react-native-webview bridge) -
 *     they have it, so do not nag;
 *   - we are not on iOS (see the Android note below);
 *   - we are in iOS SAFARI, where the native Smart App Banner does this job
 *     better than any bar we could draw (see appleItunesApp());
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

/** Which page is asking, so the pitch matches what they came here to do. */
export type AppBannerSurface = "booking" | "shop" | "manage" | "line";

const copyFor = (
  /** The shop's word for a visit. Neutral default: this renders on public
   *  pages that may not know the business type yet. */
  serviceNoun: string,
): Record<AppBannerSurface, { headline: string; body: string }> => ({
  booking: {
    headline: "Book faster next time",
    body: `Save your details, rebook in two taps, and get a reminder before your ${serviceNoun}.`,
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

/**
 * iOS Safari specifically - where Apple draws its own banner from the meta tag
 * and ours would be a second, uglier one directly underneath it.
 *
 * Every iOS browser ships "Safari" in its user agent because they are all
 * WebKit; the alternatives identify themselves with their own token first
 * (CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge, OPT = Opera). So the test is
 * "claims Safari and claims nothing else".
 */
function isIosSafari(): boolean {
  if (!isIos()) return false;
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/crios|fxios|edgios|opt\//i.test(ua);
}

export function GetTheApp({
  surface,
  serviceNoun = "visit",
}: {
  surface: AppBannerSurface;
  /**
   * The shop word for a visit. NEUTRAL default on purpose: this banner renders
   * on public pages that may not know the business type, and "visit" is right
   * for every vertical where a guess would be wrong for most.
   */
  serviceNoun?: string;
}) {
  // Gated entirely on the client: userAgent, the RN bridge and localStorage are
  // browser-only, and rendering this on the server would hand the client a
  // banner it then removes - a hydration mismatch on a customer's first paint.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isInNativeApp()) return;
    if (!isIos()) return; // no Android listing to send anyone to
    if (isIosSafari()) return; // Apple's own banner is already there
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private mode / storage blocked: showing it once is the friendlier miss */
    }
    setShow(true);
  }, []);

  if (!show) return null;
  const copy = copyFor(serviceNoun)[surface];

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
          <a
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-gold px-5 font-semibold text-charcoal-900"
            href={MOBILE_APP.appStoreUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get the app
          </a>
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
