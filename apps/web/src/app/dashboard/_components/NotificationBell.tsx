"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { WHATS_NEW, unseenWhatsNew } from "@chairback/config/whatsNew";
import type { BellSignal } from "@/lib/notificationSignals";
import { WhatsNewSection } from "./WhatsNewSection";
import { markWhatsNewSeenAction } from "./whatsNewActions";

/**
 * The header bell: what needs the barber right now, in one place.
 *
 * Every number in here already existed and was already rendered somewhere in
 * the product — people on the waitlist, conversations the AI handed off, setup
 * steps still blocking go-live. The problem was that each one was invisible
 * until you happened to open the page it lived on, so a shop could sit for days
 * with three people waiting and never know.
 *
 * There is deliberately no "mark as read". The schema has no notifications
 * table and no read-state column anywhere, and the badge is derived per render:
 * it means "N things need you right now" and decays to zero as the queues get
 * worked. A seen-flag would mean building the whole notifications backend this
 * is specifically avoiding.
 *
 * WHAT'S NEW rides in the same panel - the one exception to "no read state",
 * and a deliberately small one: a single marker per person
 * (User.whatsNewSeenId) over a list that lives in code
 * (@chairback/config/whatsNew). Unseen updates show a GOLD dot, never the red
 * count: news must not look like work that needs the barber right now.
 * Opening the bell marks them seen - on every device - while this open still
 * shows which ones were new.
 */
export function NotificationBell({
  signals,
  whatsNew = null,
  demo = false,
}: {
  signals: BellSignal[];
  whatsNew?: { seenId: string | null; accountCreatedAt: string } | null;
  /** The read-only demo session: nothing may be stamped as seen. */
  demo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // What was new when the page loaded. Kept for this visit so the entries stay
  // marked "New" in the open panel after the marker has been saved.
  const unseenIds = useMemo(
    () =>
      new Set(
        whatsNew ? unseenWhatsNew(whatsNew.seenId, new Date(whatsNew.accountCreatedAt)).map((e) => e.id) : [],
      ),
    [whatsNew],
  );
  const [updatesSeen, setUpdatesSeen] = useState(false);
  const hasUnseenUpdates = unseenIds.size > 0 && !updatesSeen;

  function toggle() {
    setOpen((v) => !v);
    if (hasUnseenUpdates && !demo && WHATS_NEW[0]) {
      setUpdatesSeen(true);
      void markWhatsNewSeenAction(WHATS_NEW[0].id).catch(() => {
        // Best-effort: the dot simply shows again next time.
      });
    }
  }
  // Portals need a DOM; this component is server-rendered into the layout.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const total = signals.reduce((n, s) => n + s.count, 0);
  // Past 99 the exact number stops being actionable and starts breaking the
  // badge's width. Same cap the waitlist shortcut uses.
  const shown = total > 99 ? "99+" : String(total);
  const needs =
    total === 0
      ? "Notifications — nothing needs you right now."
      : `Notifications — ${total} ${total === 1 ? "thing needs" : "things need"} you.`;
  const label = hasUnseenUpdates
    ? `${needs} ${unseenIds.size} new ${unseenIds.size === 1 ? "update" : "updates"}.`
    : needs;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-expanded={open}
        className="relative shrink-0 rounded-full border border-subtle p-2 text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {total > 0 && (
          // aria-hidden: the count is already spoken by the button's label, and
          // a bare "3" read out after it is noise.
          //
          // `text-charcoal-900` is doing real work here rather than meaning
          // "dark": --cb-s900 FLIPS between themes (#0E0E10 dark, #F4F0E7
          // light) while --cb-danger goes the other way (#F87171 dark, #DC2626
          // light), so this one pair stays legible in both. A literal colour
          // would be unreadable in one of them.
          <span
            aria-hidden
            className="absolute -right-1 -top-1 min-w-[1.15rem] rounded-full bg-danger-soft px-1 text-[10px] font-bold leading-[1.15rem] text-charcoal-900"
          >
            {shown}
          </span>
        )}
        {total === 0 && hasUnseenUpdates && (
          // News, not work: a gold dot, never the red count. aria-hidden -
          // the label already says how many updates are new.
          <span
            aria-hidden
            data-qa="whats-new-dot"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-gold ring-2 ring-charcoal-900"
          />
        )}
      </button>

      {/* PORTALED TO <body>, and not optional: this renders inside the
          dashboard's `nav.glass`, whose `backdrop-filter` makes it the
          containing block for its position:fixed descendants. Left in place,
          `fixed inset-0` would resolve against the ~54px nav pill instead of
          the viewport and the panel would be clipped into nothing. Same reason
          FeatureSearch, MoreSheet and the demo tour all portal. */}
      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 pb-10 pt-20 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Notifications"
              className="glass mx-auto w-full max-w-sm overflow-hidden rounded-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="border-b border-subtle px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">
                Needs you
              </p>
              {signals.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted">
                  You&apos;re all caught up.
                </p>
              ) : (
                <ul>
                  {signals.map((s) => (
                    <li key={s.key}>
                      <Link
                        href={s.href}
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-charcoal-700"
                      >
                        {/* min-w-0 so a long line truncates instead of pushing
                            the count off the edge at 320px. */}
                        <span className="min-w-0 truncate text-offwhite">{s.label}</span>
                        <span className="shrink-0 text-xs text-muted" aria-hidden>
                          →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <WhatsNewSection entries={WHATS_NEW} unseenIds={unseenIds} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
