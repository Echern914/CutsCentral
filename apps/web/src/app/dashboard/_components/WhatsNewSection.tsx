"use client";

import type { WhatsNewEntry } from "@chairback/config/whatsNew";

/**
 * "What's new" inside the header bell: the features and fixes that shipped,
 * newest first, with the ones this person hasn't seen marked New.
 *
 * Separate from "Needs you" on purpose. That list is work waiting on the
 * barber and decays as they do it; this is news, and it must never make the
 * red count look like something is urgent.
 */

/** How many entries the bell shows; the rest are history. */
export const WHATS_NEW_SHOWN = 6;

export function WhatsNewSection({
  entries,
  unseenIds,
}: {
  entries: readonly WhatsNewEntry[];
  unseenIds: ReadonlySet<string>;
}) {
  const shown = entries.slice(0, WHATS_NEW_SHOWN);
  if (shown.length === 0) return null;
  return (
    <section aria-label="What's new" data-qa="whats-new">
      <p className="border-y border-subtle px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">
        What&apos;s new
      </p>
      <ul className="divide-y divide-subtle">
        {shown.map((e) => {
          const isNew = unseenIds.has(e.id);
          return (
            <li key={e.id} className="px-4 py-3" data-qa="whats-new-entry">
              <div className="flex items-center gap-2">
                {/* Theme tokens only: a raw palette colour (sky-300) does not
                    flip with the light theme and all but vanishes on it. */}
                <span
                  className={
                    e.kind === "fix"
                      ? "rounded-full border border-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-offwhite"
                      : "rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold"
                  }
                >
                  {e.kind === "fix" ? "Fix" : "New feature"}
                </span>
                {isNew && <span className="text-[10px] font-semibold uppercase tracking-wide text-gold">New</span>}
                <span className="ml-auto shrink-0 text-[11px] text-muted">{shortDate(e.date)}</span>
              </div>
              {/* min-w-0 + break-words: a long title wraps at 320px instead of
                  pushing the panel wider than the phone. */}
              <p className="mt-1.5 min-w-0 break-words text-sm font-medium text-offwhite">{e.title}</p>
              <p className="mt-0.5 min-w-0 break-words text-xs leading-relaxed text-muted">{e.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Sep 30" - the entry's own calendar day, never shifted by a time zone. */
function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
