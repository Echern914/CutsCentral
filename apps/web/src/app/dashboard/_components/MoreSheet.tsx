"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  FEATURE_CATEGORIES,
  FEATURE_INDEX,
  type FeatureIndexEntry,
} from "@chairback/config/features";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

/**
 * The "More" tab's sheet: the whole FEATURE_INDEX as a browsable directory,
 * grouped by category. This is what makes a 5-tab bar possible — the other
 * ~11 destinations that used to be crammed into the pill strip live here, and
 * a barber can now DISCOVER a feature instead of having to already know its
 * name to search for it.
 *
 * Deliberately a plain list of links, not a second search box: FeatureSearch
 * (Ctrl/Cmd-K) already owns "I know what I want"; this owns "show me what's
 * here". Both read the same index, so neither can drift from the other.
 */
export function MoreSheet({
  open,
  onClose,
  isAdmin = false,
  rewardsEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
}) {
  // Portals need a DOM to target; SSR has none. Same mounted gate the feature
  // palette and demo tour use.
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Inside the iOS app, drop anything pointing at /dashboard/billing. That is
  // BOTH "Plan & billing" and "AI receptionist" — they share the href — and
  // both would be a back door onto Stripe checkout, which the App Store
  // forbids in-app (Guideline 3.1.1). Same rule as FeatureSearch; keep them in
  // sync. `null` (pre-hydration) shows everything, but the sheet only opens on
  // a tap, long after the check resolves.
  const inApp = useIsNativeApp();
  const visible = FEATURE_INDEX.filter(
    (f) =>
      !(inApp && f.href.startsWith("/dashboard/billing")) &&
      // A rewards-off shop has no Rewards pages (they redirect), so don't
      // advertise the loyalty features that land there.
      (rewardsEnabled || !f.href.startsWith("/dashboard/rewards")),
  );

  // Esc closes; focus moves into the sheet on open and back to the page after.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    // Lock the page behind the sheet so a scroll gesture moves the sheet, not
    // the dashboard underneath it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="All features"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        className="glass animate-fade-in relative max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl px-4 pt-4 sm:max-h-[80dvh] sm:max-w-2xl sm:rounded-3xl sm:px-6"
        // The sheet is the bottom-most surface in the app, so it owns the
        // home-indicator gap itself (the native shell insets only the TOP).
        style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
      >
        <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center justify-between bg-charcoal-800/80 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
          <h2 className="font-display text-lg tracking-tight">Everything else</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
          >
            Done
          </button>
        </div>

        {FEATURE_CATEGORIES.map((cat) => {
          const items = visible.filter((f) => f.category === cat.id);
          if (items.length === 0) return null;
          return (
            <section key={cat.id} className="mb-6">
              <h3 className="px-1 text-xs uppercase tracking-[0.16em] text-muted">
                {cat.name}
              </h3>
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {items.map((f) => (
                  <li key={f.id}>
                    <FeatureLink feature={f} onNavigate={onClose} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {/* Support sits outside FEATURE_INDEX: /support is a PUBLIC page (no
            shop context), and the index only holds /dashboard and /demo hrefs.
            It has to stay reachable from inside the iOS app — App Store
            Guideline 1.5 wants support one tap away — and this sheet is now the
            only nav that could carry it, so it is hard-coded here rather than
            inherited from the index. */}
        <section className="mb-2">
          <h3 className="px-1 text-xs uppercase tracking-[0.16em] text-muted">
            Support
          </h3>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <li>
              <Link
                href="/support"
                onClick={onClose}
                className="block rounded-2xl border border-subtle px-3.5 py-3 transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                <span className="text-sm font-medium">Help &amp; contact</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Guides, FAQs, and how to reach a human
                </span>
              </Link>
            </li>
            {isAdmin && (
              <li>
                <Link
                  href="/admin"
                  onClick={onClose}
                  className="block rounded-2xl border border-subtle px-3.5 py-3 transition-colors duration-150 ease-out hover:bg-charcoal-700"
                >
                  <span className="text-sm font-medium">Admin</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Cross-shop operator tools
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function FeatureLink({
  feature,
  onNavigate,
}: {
  feature: FeatureIndexEntry;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={feature.href}
      onClick={onNavigate}
      className="block rounded-2xl border border-subtle px-3.5 py-3 transition-colors duration-150 ease-out hover:bg-charcoal-700"
    >
      <span className="text-sm font-medium">{feature.name}</span>
      <span className="mt-0.5 block text-xs text-muted">{feature.description}</span>
    </Link>
  );
}

/** SSR has no DOM for a portal to target; flip to true after the first mount. */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
