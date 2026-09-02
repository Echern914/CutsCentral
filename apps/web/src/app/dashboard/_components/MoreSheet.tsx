"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  FEATURE_CATEGORIES,
  resolveHref,
  searchableFeatures,
  visibleFeatures,
  type FeatureIndexEntry,
  type SeatRole,
  flagsOffFor,
} from "@chairback/config/features";
import { searchFeatures } from "@chairback/config/helpMatch";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { lockedTier, type FeatureLocks } from "@/lib/featureLocks";
import { recentFeatureIds, rememberFeature } from "@/lib/recentFeatures";
import { PlanBadge } from "./PlanBadge";

/**
 * The "More" tab's sheet: the whole FEATURE_INDEX as a browsable directory,
 * grouped by category. This is what makes a 5-tab bar possible — the other
 * ~11 destinations that used to be crammed into the pill strip live here, and
 * a barber can now DISCOVER a feature instead of having to already know its
 * name to search for it.
 *
 * It ALSO carries a search box, which it did not at first. FeatureSearch
 * (Ctrl/Cmd-K) owns "I know what I want", but on a phone that palette is a
 * small magnifier in the header, and the More tab is where a thumb actually
 * goes when something is missing - so a person who could not find Affiliates
 * scrolled this directory, did not spot it, and concluded it did not exist.
 * The box types against the same matcher and the same registry the palette
 * uses, so the two never disagree; the directory below it is the "show me
 * what's here" browse for when the name is not known.
 */
export function MoreSheet({
  open,
  onClose,
  isAdmin = false,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
  role,
  locks,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
  affiliateProgramEnabled?: boolean;
  /** The seat browsing. Manager-only entries drop out for an employee. */
  role?: SeatRole;
  /** Premium lock flags — tier-tagged rows get a diamond when locked. */
  locks?: FeatureLocks;
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
  // One question to the registry replaces three local rules: the 3.1.1 billing
  // filter, the rewards-off route-prefix test (now a declared `flag` on the
  // entries themselves, not a guess from the href), and the role gate.
  // Unlisted entry, so it never appears in the directory above — but still
  // resolved rather than hard-coded.
  const supportHref = resolveHref("support") ?? "/support";
  const ctx = useMemo(
    () => ({
      role,
      inApp: inApp === true,
      flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }),
    }),
    [role, inApp, rewardsEnabled, affiliateProgramEnabled],
  );
  const visible = useMemo(() => visibleFeatures(ctx), [ctx]);
  // The search box types against the wider index: the directory hides the
  // unlisted Contact support entry (it has its own section below), but "help"
  // typed here must still find it.
  const typeable = useMemo(() => searchableFeatures(ctx), [ctx]);
  const askHref = resolveHref("assistant", { role });

  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  // A fresh sheet every time: last time's query would hide the directory, and
  // the recents are re-read because another tab may have added to them.
  useEffect(() => {
    if (open) {
      setQuery("");
      setRecentIds(recentFeatureIds());
    }
  }, [open]);
  const recents = useMemo(
    () =>
      recentIds
        .map((id) => visible.find((f) => f.id === id))
        .filter((f): f is FeatureIndexEntry => f !== undefined),
    [recentIds, visible],
  );
  const hits = useMemo(
    () => (query.trim() ? searchFeatures(query, typeable).map((h) => h.entry) : null),
    [query, typeable],
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
        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-charcoal-800/80 px-4 pb-3 pt-2 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex items-center justify-between">
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
          {/* text-base, not text-sm: iOS Safari zooms the page on focus for
              anything under 16px, and this box is mostly tapped on a phone. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type what you're looking for…"
            aria-label="Search everything"
            autoComplete="off"
            enterKeyHint="search"
            className="mt-2 w-full rounded-xl border border-subtle bg-charcoal-900/60 px-3.5 py-2.5 text-base text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25"
          />
        </div>

        {hits !== null ? (
          <section className="mb-4" aria-label="Search results">
            {hits.length === 0 ? (
              <div className="px-1 py-6 text-center text-sm text-muted">
                <p>Nothing here is called &ldquo;{query.trim()}&rdquo;.</p>
                {/* Same hand-off as the palette: a dead end teaches "it does
                    not exist"; the assistant also reads the help corpus and
                    can answer a "how do I…" that no feature NAME matches. */}
                {askHref && (
                  <Link
                    href={`${askHref}?q=${encodeURIComponent(query.trim())}`}
                    onClick={onClose}
                    className="mt-3 inline-block rounded-full border border-gold/40 px-3.5 py-1.5 text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
                  >
                    Ask the assistant about &ldquo;{query.trim()}&rdquo; →
                  </Link>
                )}
              </div>
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {hits.map((f) => (
                  <li key={f.id}>
                    <FeatureLink
                      feature={f}
                      tag={categoryName(f)}
                      current={isCurrentPage(f, pathname)}
                      onNavigate={onClose}
                      lockedAs={lockedTier(f.tier, locks)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
            {recents.length > 0 && (
              <section className="mb-6">
                <h3 className="px-1 text-xs uppercase tracking-[0.16em] text-muted">Recent</h3>
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {recents.map((f) => (
                    <li key={f.id}>
                      <FeatureLink
                        feature={f}
                        tag={categoryName(f)}
                        current={isCurrentPage(f, pathname)}
                        onNavigate={onClose}
                        lockedAs={lockedTier(f.tier, locks)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

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
                        <FeatureLink
                          feature={f}
                          current={isCurrentPage(f, pathname)}
                          onNavigate={onClose}
                          lockedAs={lockedTier(f.tier, locks)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}

        {/* Support is an UNLISTED registry entry: /support is a PUBLIC page, so
            it has no business in the browsable directory above, but it must stay
            reachable from inside the iOS app (App Store Guideline 1.5 wants
            support one tap away) and this sheet is the only nav that can carry
            it. Unlisted-but-resolvable is exactly that case — the route still
            comes from the registry rather than being typed here.

            /admin is NOT a registry entry and must not become one: it is a
            cross-shop operator tool, and the registry's whole contract is that
            everything in it is scoped to the shop the caller is acting on. */}
        <section className="mb-2">
          <h3 className="px-1 text-xs uppercase tracking-[0.16em] text-muted">
            Support
          </h3>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <li>
              <Link
                href={supportHref}
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

/** The shelf a feature sits on, for a row shown OUTSIDE its shelf (search, recents). */
function categoryName(f: FeatureIndexEntry): string {
  return FEATURE_CATEGORIES.find((c) => c.id === f.category)?.name ?? "";
}

/**
 * "You're here" - the row for the page underneath the sheet. Only a BARE href
 * counts: the six `?tab=` entries all live on /dashboard/booking, and marking
 * every one of them would say nothing.
 */
function isCurrentPage(f: FeatureIndexEntry, pathname: string | null): boolean {
  if (!pathname || f.href.includes("?") || f.href.includes("#")) return false;
  return f.href === pathname;
}

function FeatureLink({
  feature,
  tag,
  current = false,
  onNavigate,
  lockedAs,
}: {
  feature: FeatureIndexEntry;
  /** Where this lives, when the row is shown away from its shelf. */
  tag?: string;
  /** This row is the page the sheet opened over. */
  current?: boolean;
  onNavigate: () => void;
  /** Plan diamond to show when the shop's plan doesn't include this feature. */
  lockedAs: "pro" | "pro_ai" | null;
}) {
  return (
    // A locked row still NAVIGATES — the feature's own page explains the lock
    // and (on the web) carries the upgrade link. A dead row would just read
    // as broken.
    <Link
      href={feature.href}
      aria-current={current ? "page" : undefined}
      onClick={() => {
        rememberFeature(feature.id);
        onNavigate();
      }}
      className={`block rounded-2xl border px-3.5 py-3 transition-colors duration-150 ease-out hover:bg-charcoal-700 ${
        current ? "border-gold/40 bg-gold/5" : "border-subtle"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{feature.name}</span>
        {lockedAs && <PlanBadge tier={lockedAs} />}
        {(current || tag) && (
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted">
            {current ? "You're here" : tag}
          </span>
        )}
      </span>
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
