"use client";

import Link from "next/link";
import {
  BILLING_PLANS_PATH,
  openBillingInBrowser,
  useNativeBillingLink,
} from "@/lib/useNativeBillingLink";

/** The in-app words. No price, no plan pitch: where the plan is managed. */
export const NATIVE_BILLING_LABEL = "Manage plan on getchairback.com";

const NATIVE_BUTTON =
  "inline-flex items-center gap-1 rounded-full border border-gold/50 px-3.5 py-1.5 text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/**
 * THE one way any surface sends a barber to change their plan.
 *
 *  - On the web: an ordinary link to the plan cards on the billing page, with
 *    whatever words and look the call site gives it.
 *  - In the iOS app (a build that can open Safari): "Manage plan on
 *    getchairback.com ↗", a button that asks the app to open billing in SAFARI.
 *    It never navigates the WebView itself - buying happens in the browser,
 *    which is what Guideline 3.1.1 allows on the US storefront since the 2025
 *    Epic v. Apple injunction. No amount is ever shown in the app.
 *  - In an older app build, or with NATIVE_EXTERNAL_BILLING_LINK off: nothing,
 *    which is what the app showed before (lib/useNativeBillingLink.ts says why
 *    an older build cannot be trusted with a plain link).
 *
 * Before hydration the web link renders inside `data-native-hide`, which the
 * app hides from the very first paint, so the app never flashes it.
 *
 * `wrapClassName` puts the result in a <p> - only when there IS a result, so a
 * build that shows nothing leaves no empty, spaced-out paragraph behind.
 */
export function UpgradeOnWebLink({
  children,
  className = "font-semibold text-gold hover:underline",
  wrapClassName,
}: {
  /** The web link's words, e.g. "Start your plan". */
  children: React.ReactNode;
  /** The web link's look. The app button has its own, the same everywhere. */
  className?: string;
  wrapClassName?: string;
}) {
  const mode = useNativeBillingLink();
  if (mode === "none") return null;

  const inner =
    mode === "native" ? (
      <button type="button" onClick={openBillingInBrowser} className={NATIVE_BUTTON}>
        {NATIVE_BILLING_LABEL}
        <OpensBrowserMark />
      </button>
    ) : (
      // "web", or not yet known: the browser experience, hidden from the app's
      // first paint until hydration says which this is.
      <span className="contents" data-native-hide>
        <Link href={BILLING_PLANS_PATH} className={className}>
          {children}
        </Link>
      </span>
    );

  return wrapClassName ? <p className={wrapClassName}>{inner}</p> : inner;
}

/**
 * " ↗" for anything that leaves the app for Safari, with words for a screen
 * reader. Shared with the More sheet and the palette's "Plan & billing ↗".
 */
export function OpensBrowserMark() {
  return (
    <>
      <span aria-hidden> ↗</span>
      <span className="sr-only"> (opens your browser)</span>
    </>
  );
}

/**
 * Children only where the app button above will actually show - an app build
 * that can open Safari, with the kill switch on. For an in-app line that only
 * makes sense next to that button (the trial countdown, which the app otherwise
 * leaves out because the web version quotes a price).
 */
export function IfNativeBillingLink({ children }: { children: React.ReactNode }) {
  return useNativeBillingLink() === "native" ? <>{children}</> : null;
}
