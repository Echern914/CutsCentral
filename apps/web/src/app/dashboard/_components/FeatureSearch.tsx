"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  FEATURE_CATEGORIES,
  isBillingHref,
  resolveHref,
  searchableFeatures,
  type FeatureIndexEntry,
  type SeatRole,
  flagsOffFor,
} from "@chairback/config/features";
import { searchFeatures } from "@chairback/config/helpMatch";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { openBillingInBrowser, useNativeBillingLink } from "@/lib/useNativeBillingLink";
import { OpensBrowserMark } from "@/components/UpgradeOnWebLink";
import { recentFeatureIds, rememberFeature } from "@/lib/recentFeatures";
import { lockedTier, offeredFeatures, type FeatureLocks } from "@/lib/featureLocks";
import { openAssistant } from "@/components/help/openAssistant";
import { PlanBadge } from "./PlanBadge";

/**
 * The dashboard's feature finder: a magnifier in the nav (or Ctrl/Cmd-K) opens
 * a small command palette over FEATURE_INDEX, so "where do I set up the
 * waitlist?" is typed, not hunted. Enter opens the feature's dashboard page;
 * entries that exist on the CLIENT side also offer a jump straight to their
 * step of the live demo (/demo?step=…).
 *
 * Matching is deliberately simple — name prefix beats name substring beats
 * synonym substring beats description substring. The index's synonyms carry
 * the vocabulary load.
 */
export function FeatureSearch({
  locks,
  role,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
}: {
  locks?: FeatureLocks;
  /** The seat browsing. Manager-only entries drop out for an employee. */
  role?: SeatRole;
  rewardsEnabled?: boolean;
  affiliateProgramEnabled?: boolean;
} = {}) {
  const router = useRouter();
  // The registry decides what this seat can reach — including the 3.1.1 rule
  // that drops every billing destination inside the native shell ("Plan &
  // billing" and "AI receptionist" both deep-link there, and this palette
  // navigates with router.push, an SPA nav the shell cannot intercept).
  // `null` (pre-hydration) reads as the browser, but the palette only opens on
  // a tap, by which point the check has resolved.
  const inApp = useIsNativeApp();
  // The one exception: an app build that can open Safari (kill switch on)
  // lists "Plan & billing ↗", and choosing it opens billing THERE - `go` below
  // never router.pushes a billing href inside the app.
  const billingOnWeb = useNativeBillingLink() === "native";
  // `searchableFeatures`, not `visibleFeatures`: the palette also types
  // against the unlisted-but-searchable entries (Contact support), which have
  // no shelf in the More directory but must not dead-end here.
  const index = useMemo(
    () =>
      offeredFeatures(
        searchableFeatures({
          role,
          inApp: inApp === true,
          billingOnWeb,
          flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }),
        }),
        locks,
      ),
    [inApp, billingOnWeb, role, rewardsEnabled, affiliateProgramEnabled, locks],
  );
  // Where a query that matches nothing is handed off to. The assistant reads
  // the same registry PLUS the help corpus, so it can answer the "how do I…"
  // questions a feature name cannot.
  const askHref = resolveHref("assistant", { role });
  const [open, setOpen] = useState(false);
  // Portals need a DOM to target, which SSR has none of — same mounted gate the
  // demo tour uses. The palette only opens on a tap/Ctrl-K, long after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Global shortcut: Ctrl/Cmd-K toggles, Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setQuery("");
      setCursor(0);
      // Focus after the panel paints.
      const t = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(t);
    }
    // Restore focus to the trigger on close (WCAG 2.4.3) — but only after a
    // real open/close cycle, not on mount.
    if (wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Modal focus trap: Tab cycles within the dialog instead of escaping into
  // the page dimmed behind it (WCAG 2.4.3 / aria-modal contract).
  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button, input, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Matching moved into packages/config (searchFeatures) so this palette and
  // the help bubble share one tokenizer, one synonym table and one Damerau
  // distance. The ladder that used to live here scored by whole-query
  // SUBSTRING, which returned nothing for 37 of 46 real keywords ("buffer",
  // "lunch break", "card punch") and confident garbage for others ("age" hit
  // "Public shop p-AGE"). See the note on searchFeatures for the full autopsy.
  // The last few things this person opened lead the list when nothing is
  // typed. Read on open, not at mount: another tab may have added to it.
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (open) setRecentIds(recentFeatureIds());
  }, [open]);
  const recents = useMemo(
    () =>
      recentIds
        .map((id) => index.find((f) => f.id === id))
        .filter((f): f is FeatureIndexEntry => f !== undefined),
    [recentIds, index],
  );
  const results = useMemo(() => {
    if (!query.trim()) return [...recents, ...index.filter((f) => !recents.includes(f))];
    return searchFeatures(query, index).map((h) => h.entry);
  }, [query, index, recents]);

  const go = useCallback(
    (feature: FeatureIndexEntry | null, href: string) => {
      if (feature) rememberFeature(feature.id);
      setOpen(false);
      // In the app, billing opens in Safari and the WebView stays put.
      if (billingOnWeb && isBillingHref(href)) {
        void openBillingInBrowser();
        return;
      }
      router.push(href);
    },
    [router, billingOnWeb],
  );

  /**
   * "Search or ask": the typed words go to the Assistant panel, which answers
   * them through resolveSupport right here on the page. Where no panel is
   * listening, the full Assistant page takes them instead, so this is never
   * a dead end.
   */
  const ask = useCallback(
    (question: string) => {
      setOpen(false);
      if (openAssistant(question, triggerRef.current)) return;
      if (askHref) router.push(`${askHref}?q=${encodeURIComponent(question)}`);
    },
    [askHref, router],
  );

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[Math.min(cursor, results.length - 1)];
      if (hit) go(hit, hit.href);
    }
  }

  // Keep the highlighted row scrolled into view as ↑/↓ move it.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search or ask (Ctrl+K)"
        title="Search or ask (Ctrl+K)"
        /* A 44px icon on phones and tablets, where the bar has no room; a
           field-shaped button on a computer, where the sidebar has taken the
           tabs and the bar has room for it. */
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite lg:h-10 lg:w-72 lg:justify-start lg:gap-2.5 lg:border lg:border-subtle-strong lg:bg-charcoal-800 lg:px-3 lg:text-sm"
      >
        <svg
          className="h-5 w-5 shrink-0 lg:h-4 lg:w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="hidden lg:inline">Search or ask</span>
        <kbd className="ml-auto hidden rounded border border-subtle bg-charcoal px-1.5 font-sans text-[11px] text-muted lg:inline">
          Ctrl K
        </kbd>
      </button>

      {/* PORTALED TO <body> — not merely tidy, it's the whole reason the palette
          works. This component renders inside the dashboard's `nav.glass`, and
          that pill carries `backdrop-filter: blur(14px)`. A filter/backdrop-filter
          makes an element the CONTAINING BLOCK for its position:fixed descendants
          (same rule as `transform`), so `fixed inset-0` resolved against the
          54px-tall nav instead of the viewport: the overlay came out ~1150x120,
          the input sat jammed in the header, and the results list — all 33 rows,
          correctly matched and present in the DOM — was clipped away by this
          div's own overflow-y-auto. Typing did nothing visible, so the search
          read as completely broken. The demo tour hit this first and portals for
          the same reason. */}
      {open && mounted &&
        createPortal(
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 pb-10 pt-20 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search or ask"
            className="glass mx-auto w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapTab}
          >
            <div className="flex items-center gap-3 border-b border-subtle px-4 py-3">
              <svg
                className="h-4 w-4 shrink-0 text-muted"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onInputKey}
                placeholder="Search or ask: waitlist, deposits, how do I…"
                className="w-full bg-transparent text-base text-offwhite placeholder:text-muted focus:outline-none sm:text-sm"
                aria-label="Search or ask"
                role="combobox"
                aria-expanded={true}
                aria-controls="feature-search-results"
                aria-autocomplete="list"
                aria-activedescendant={
                  results.length > 0
                    ? `feature-search-option-${Math.min(cursor, results.length - 1)}`
                    : undefined
                }
              />
              <kbd className="hidden shrink-0 rounded border border-subtle px-1.5 py-0.5 text-[10px] text-muted sm:block">
                esc
              </kbd>
            </div>
            <ul
              ref={listRef}
              id="feature-search-results"
              role="listbox"
              aria-label="Matching features"
              className="max-h-80 overflow-y-auto py-1.5"
            >
              {results.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-muted">
                  <p>Nothing here is called &ldquo;{query.trim()}&rdquo;.</p>
                  {/* A dead end is the one outcome that makes a search box
                      worse than none: the person concludes the feature does
                      not exist. Hand the words to the assistant instead - it
                      also reads the help corpus, so "how do I…" gets an answer
                      where a feature NAME could not. */}
                  {askHref && (
                    <button
                      type="button"
                      onClick={() => ask(query.trim())}
                      className="mt-3 inline-flex min-h-[44px] items-center rounded-xl border border-subtle-strong bg-charcoal-800 px-4 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                    >
                      Ask the assistant about &ldquo;{query.trim()}&rdquo;
                    </button>
                  )}
                </li>
              )}
              {results.map((f, i) => (
                <Row
                  key={f.id}
                  feature={f}
                  index={i}
                  active={i === cursor}
                  tag={!query.trim() && recents.includes(f) ? "Recent" : categoryName(f)}
                  onHover={() => setCursor(i)}
                  onOpen={() => go(f, f.href)}
                  opensBrowser={billingOnWeb && isBillingHref(f.href)}
                  onDemo={f.tourStepId ? () => go(null, `/demo?step=${f.tourStepId}`) : undefined}
                  lockedAs={lockedTier(f.tier, locks)}
                />
              ))}
            </ul>
            {/* The "or ask" half: typed words that DID match features may
                still be a question ("how do I take deposits"), so the ask is
                offered under the matches too, not only when nothing matched. */}
            {askHref && query.trim() && results.length > 0 && (
              <div className="border-t border-subtle p-1.5">
                <button
                  type="button"
                  onClick={() => ask(query.trim())}
                  className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                >
                  <svg
                    className="h-4 w-4 shrink-0 text-muted"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20.5 12.2c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.35L4.5 20.5l1.3-3.3A6.7 6.7 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
                  </svg>
                  <span className="min-w-0 truncate">
                    Ask &ldquo;{query.trim()}&rdquo;
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** The More-sheet shelf this feature sits on, for the row's tag. */
function categoryName(f: FeatureIndexEntry): string {
  return FEATURE_CATEGORIES.find((c) => c.id === f.category)?.name ?? "";
}

function Row({
  feature,
  index,
  active,
  tag,
  onHover,
  onOpen,
  onDemo,
  lockedAs,
  opensBrowser = false,
}: {
  feature: FeatureIndexEntry;
  /** Opens in Safari, not here (Plan & billing in the app): marked ↗. */
  opensBrowser?: boolean;
  index: number;
  active: boolean;
  /** "Recent", or the More-sheet shelf - so a hit says WHERE it lives, too. */
  tag: string;
  onHover: () => void;
  onOpen: () => void;
  /** Present when this feature has a live-demo step to jump to. */
  onDemo?: () => void;
  /** Plan diamond when the shop's plan doesn't include this feature. */
  lockedAs?: "pro" | "pro_ai" | null;
}) {
  return (
    <li
      data-index={index}
      id={`feature-search-option-${index}`}
      role="option"
      aria-selected={active}
    >
      <div
        className={`flex items-center gap-2 px-2 py-1 ${active ? "bg-charcoal-700/70" : ""}`}
        onMouseEnter={onHover}
      >
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-offwhite">
            <span className="min-w-0 truncate">
              {feature.name}
              {opensBrowser && <OpensBrowserMark />}
            </span>
            {lockedAs && <PlanBadge tier={lockedAs} />}
            {tag && (
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted">
                {tag}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted">{feature.description}</p>
        </button>
        {onDemo && (
          <button
            type="button"
            onClick={onDemo}
            className="shrink-0 rounded-md border border-gold/40 px-2.5 py-1 text-[10px] font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
          >
            See it live →
          </button>
        )}
      </div>
    </li>
  );
}
