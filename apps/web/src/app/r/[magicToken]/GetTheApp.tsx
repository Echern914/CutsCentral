"use client";

import { useEffect, useState } from "react";
import type { RewardsTheme } from "./theme";

/**
 * "Get the app" nudge on the rewards page.
 *
 * Shown ONLY to a customer who opened their rewards link in a normal mobile
 * browser and does NOT already have the native app. The pitch is exactly the
 * value the web page can't give them: push notifications (no SMS needed) the
 * moment they earn a punch or a reward is ready, plus their full rewards always
 * a tap away on the home screen.
 *
 * It deliberately renders NOTHING when:
 *  - we're inside the native app already (the react-native-webview bridge is
 *    present) - they have it, so don't nag,
 *  - we're on desktop (the App Store link is for a phone),
 *  - there's no App Store URL configured yet (nothing to send them to),
 *  - the customer dismissed it before (remembered per-device in localStorage).
 *
 * No App Store URL => the component is a no-op, so it's safe to render before the
 * app is live; flip it on by passing `appStoreUrl`.
 */

const DISMISS_KEY = "cb_get_app_dismissed";

function isInNativeApp(): boolean {
  return typeof window !== "undefined" &&
    Boolean((window as { ReactNativeWebView?: unknown }).ReactNativeWebView);
}

function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function GetTheApp({
  shopName,
  theme,
  appStoreUrl,
  playStoreUrl,
}: {
  shopName: string;
  theme: RewardsTheme;
  /** iOS App Store link. Absent => banner never shows (safe pre-launch). */
  appStoreUrl: string | null;
  /** Android Play Store link (optional; iOS-only launch leaves this null). */
  playStoreUrl?: string | null;
}) {
  // Gate entirely on the client: userAgent / the RN bridge / localStorage are all
  // browser-only, and SSR must not render a banner the client would then remove
  // (hydration mismatch). Start hidden; reveal in an effect once we've checked.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isInNativeApp()) return; // already have the app
    if (!isMobile()) return; // store links are for phones
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      /* private mode / storage blocked: just show it */
    }
    if (dismissed) return;
    // Only show if there's a relevant store link for this platform.
    const link = isIos() ? appStoreUrl : (playStoreUrl ?? appStoreUrl);
    if (!link) return;
    setShow(true);
  }, [appStoreUrl, playStoreUrl]);

  if (!show) return null;

  const storeUrl = isIos() ? appStoreUrl : (playStoreUrl ?? appStoreUrl);
  if (!storeUrl) return null;

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* non-fatal */
    }
  }

  const t = theme;

  return (
    <div
      className="relative overflow-hidden p-5"
      style={{
        backgroundColor: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: t.radius,
      }}
    >
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: t.accent }}
        aria-hidden
      />
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 text-lg leading-none opacity-50 transition-opacity duration-150 ease-out hover:opacity-100"
        style={{ color: t.muted }}
      >
        ×
      </button>
      <p className="pr-6 text-sm font-semibold">Get the {shopName} app</p>
      <p className="mt-1 text-xs" style={{ color: t.muted }}>
        Get a notification the moment you earn a punch or a reward&apos;s ready —
        no texts needed — and keep your rewards one tap away on your home screen.
      </p>
      <a
        href={storeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-block px-4 py-2.5 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.02]"
        style={{
          backgroundColor: t.accent,
          color: t.onAccent,
          borderRadius: t.buttonRadius,
        }}
      >
        {isIos() ? "Download on the App Store" : "Get the app"}
      </a>
    </div>
  );
}
