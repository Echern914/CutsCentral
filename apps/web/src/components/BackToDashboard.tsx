"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

/**
 * A "← Back to dashboard" control shown ONLY when the barber opened this public
 * page from their own dashboard (links there carry `?from=dashboard`). Real
 * customers never see it. Rendered client-side after mount so it never appears
 * during SSR / hydration and so it can read the query string + referrer.
 *
 * Public pages are theme-specific, so styling is passed in (className/style);
 * this component owns only the show/hide logic and the navigation.
 */
export function BackToDashboard({
  fallbackHref,
  label = "← Back to dashboard",
  className,
  style,
}: {
  /** Where to go when there's no usable same-origin history to pop. */
  fallbackHref: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    const from = new URLSearchParams(window.location.search).get("from");
    setShow(from === "dashboard");
  }, []);

  if (!show) return null;

  function goBack() {
    // Prefer popping history when we arrived from a same-origin page (in-app
    // navigation); otherwise (new tab / stripped referrer) push the fallback so
    // the control is never a dead end.
    let sameOrigin = false;
    try {
      sameOrigin =
        Boolean(document.referrer) &&
        new URL(document.referrer).origin === window.location.origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  }

  return (
    <button type="button" onClick={goBack} className={className} style={style}>
      {label}
    </button>
  );
}
