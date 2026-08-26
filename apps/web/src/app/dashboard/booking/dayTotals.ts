import type { AgendaRow } from "./page";

export interface DayTotals {
  /** Everything on the books today: upcoming + completed tickets. */
  revenue: number;
  /** The part already collected-by-completion. */
  doneRevenue: number;
  /** revenue - doneRevenue. */
  toComeRevenue: number;
  /** Requests not yet approved. Deliberately NOT part of `revenue`. */
  pendingRevenue: number;
  /** Counted bookings carrying no price at all. */
  unpricedCount: number;
  /** No-shows. Surfaced separately; they earn $0. */
  noShowCount: number;
  /** Minutes of the day taken off, counting overlapping blocks ONCE. */
  blockedMin: number;
  /** Bookings on the schedule (blocks and cancellations excluded). */
  count: number;
}

/**
 * The day's totals, from the WHOLE day's rows.
 *
 * Never the category-filtered slice: the footer says "Day total" and has to
 * keep meaning that while a chip filter narrows the list below it.
 *
 * Money follows the app's revenue rules — upcoming + completed tickets count,
 * canceled and pending never do, and a no-show earns nothing (the chair sat
 * empty), so it's surfaced as its own count rather than inflating the total.
 *
 * Extracted so the pinned total bar and the detail footer read from ONE
 * computation. Two copies of this arithmetic would eventually disagree, and a
 * calendar showing two different numbers for the same day is worse than either
 * of them being wrong.
 */
export function dayTotals(rows: AgendaRow[]): DayTotals {
  let revenue = 0;
  let doneRevenue = 0;
  let unpricedCount = 0;
  let pendingRevenue = 0;
  let noShowCount = 0;
  let count = 0;
  const blockSpans: { start: number; end: number }[] = [];

  for (const r of rows) {
    if (r.source === "block") {
      if (r.end && r.end > r.start) {
        const start = Date.parse(r.start);
        const end = Date.parse(r.end);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          blockSpans.push({ start, end });
        }
      }
      continue;
    }
    if (r.status !== "canceled") count++;
    if (r.status === "no_show") noShowCount++;
    if (r.status === "pending") pendingRevenue += r.price ?? 0;
    if (r.status !== "upcoming" && r.status !== "completed") continue;
    if (r.price === null) unpricedCount++;
    revenue += r.price ?? 0;
    if (r.status === "completed") doneRevenue += r.price ?? 0;
  }

  return {
    revenue,
    doneRevenue,
    toComeRevenue: revenue - doneRevenue,
    pendingRevenue,
    unpricedCount,
    noShowCount,
    blockedMin: unionMinutes(blockSpans),
    count,
  };
}

/**
 * Total minutes covered by a set of spans, counting overlap ONCE.
 *
 * Summing each span independently is the obvious version and it is wrong: a
 * shop whose external calendar holds four identical 7:15-11:15 PM blocks
 * (Acuity happily stores duplicates) reported "16h blocked off" for a day that
 * only has four hours taken. The chair can't be blocked twice, so the honest
 * measure is the union, not the sum.
 */
function unionMinutes(spans: { start: number; end: number }[]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let cur = { ...sorted[0]! };
  for (const s of sorted.slice(1)) {
    if (s.start <= cur.end) {
      // Overlapping or touching: extend, never add.
      cur.end = Math.max(cur.end, s.end);
      continue;
    }
    total += cur.end - cur.start;
    cur = { ...s };
  }
  total += cur.end - cur.start;
  return Math.round(total / 60_000);
}
