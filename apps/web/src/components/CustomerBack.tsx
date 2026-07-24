"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

/**
 * The customer-side "← Back" control for public pages (shop page, booking,
 * appointment manage). Inside the native app the customer WebView has no
 * browser chrome, so without a visible control every navigation away from the
 * rewards home is a dead end (edge-swipe exists but nobody finds it — users
 * were force-quitting the app to get back). In a normal browser it also covers
 * the "arrived from another of our pages" case.
 *
 * Shown when:
 *  - there is real history to pop AND we're in the native app or arrived from
 *    a same-origin page (back means "the page you were just on"), or
 *  - a `fallbackHref` is provided (the control is then never a dead end: with
 *    nothing to pop it navigates there instead — e.g. a booking page opened
 *    directly from a texted link still offers "← Back to {shop}").
 *
 * Hidden when the barber is previewing from their dashboard (?from=dashboard):
 * BackToDashboard owns that spot.
 *
 * Public pages are theme-specific, so styling is passed in (className/style);
 * this component owns only the show/hide logic and the navigation. Rendered
 * after mount so SSR/hydration never flashes it.
 */
export function CustomerBack({
  fallbackHref,
  label = "← Back",
  className,
  style,
}: {
  /** Where to go when there's no usable history to pop. Omit to show the
   *  control only when a real back-navigation is possible. */
  fallbackHref?: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [canPop, setCanPop] = useState(false);

  useEffect(() => {
    // Barber preview: BackToDashboard renders instead; never double up.
    const from = new URLSearchParams(window.location.search).get("from");
    if (from === "dashboard") return;

    const inApp = Boolean(
      (window as { ReactNativeWebView?: unknown }).ReactNativeWebView,
    );
    let sameOrigin = false;
    try {
      sameOrigin =
        Boolean(document.referrer) &&
        new URL(document.referrer).origin === window.location.origin;
    } catch {
      sameOrigin = false;
    }
    const pop = window.history.length > 1 && (inApp || sameOrigin);
    setCanPop(pop);
    setShow(pop || Boolean(fallbackHref));
  }, [fallbackHref]);

  if (!show) return null;

  function goBack() {
    if (canPop) router.back();
    else if (fallbackHref) router.push(fallbackHref);
  }

  return (
    <button type="button" onClick={goBack} className={className} style={style}>
      {label}
    </button>
  );
}
