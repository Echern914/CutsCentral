"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FEATURE_INDEX, type FeatureIndexEntry } from "@chairback/config/features";

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
export function FeatureSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FEATURE_INDEX;
    const scored = FEATURE_INDEX.map((f) => {
      const name = f.name.toLowerCase();
      let score = 0;
      if (name.startsWith(q)) score = 4;
      else if (name.includes(q)) score = 3;
      else if (f.synonyms.some((s) => s.toLowerCase().startsWith(q))) score = 2;
      else if (f.synonyms.some((s) => s.toLowerCase().includes(q))) score = 1.5;
      else if (f.description.toLowerCase().includes(q)) score = 1;
      return { f, score };
    });
    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.f);
  }, [query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
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
      if (hit) go(hit.href);
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
        aria-label="Search features (Ctrl+K)"
        title="Search features (Ctrl+K)"
        className="shrink-0 rounded-full border border-subtle p-2 text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
      >
        <svg
          className="h-3.5 w-3.5"
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
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 pb-10 pt-20 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search features"
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
                placeholder="Search features — waitlist, punch cards, pay direct…"
                className="w-full bg-transparent text-sm text-offwhite placeholder:text-muted focus:outline-none"
                aria-label="Search features"
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
                  Nothing matches &ldquo;{query}&rdquo; — try another word.
                </li>
              )}
              {results.map((f, i) => (
                <Row
                  key={f.id}
                  feature={f}
                  index={i}
                  active={i === cursor}
                  onHover={() => setCursor(i)}
                  onOpen={() => go(f.href)}
                  onDemo={f.tourStepId ? () => go(`/demo?step=${f.tourStepId}`) : undefined}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

function Row({
  feature,
  index,
  active,
  onHover,
  onOpen,
  onDemo,
}: {
  feature: FeatureIndexEntry;
  index: number;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
  /** Present when this feature has a live-demo step to jump to. */
  onDemo?: () => void;
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
          className="flex-1 rounded-lg px-2 py-1.5 text-left"
        >
          <p className="text-sm font-medium text-offwhite">{feature.name}</p>
          <p className="text-xs text-muted">{feature.description}</p>
        </button>
        {onDemo && (
          <button
            type="button"
            onClick={onDemo}
            className="shrink-0 rounded-full border border-gold/40 px-2.5 py-1 text-[10px] font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
          >
            See it live →
          </button>
        )}
      </div>
    </li>
  );
}
