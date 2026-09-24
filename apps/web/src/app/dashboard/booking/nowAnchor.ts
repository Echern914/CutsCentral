import type { AgendaRow } from "./page";

/**
 * WHERE TODAY OPENS.
 *
 * Drick: "When I open this it should auto scroll to the appointment I'm
 * currently at, like Acuity." A day planner is one row per hour, 8 AM (earlier
 * if something is booked earlier) to 11 PM, so checking the day at 3 PM meant
 * opening it on seven hours that were already over and scrolling past them.
 * This picks the row that belongs at the top of the screen:
 *
 *   1. the row holding the booking IN PROGRESS - the chair he is standing at.
 *      Several at once (a shop with more than one chair) means the one that
 *      started first, so the others are on screen right below it;
 *   2. otherwise the row of the NEXT booking today - what is coming up;
 *   3. otherwise the CURRENT hour's row - nothing left today, so just "now".
 *
 * Blocked time and dead bookings are never "the one I'm at": a lunch block is
 * not an appointment, and a cancellation or a no-show is not in the chair.
 * In progress means start <= now < end, compared as instants, so a booking
 * with no end (or a zero-length one) never counts as running.
 *
 * The answer is a ROW, named by the hour it starts at, and not simply an
 * hour: the planner folds each run of empty blocked hours into one band, so
 * an hour inside that run has no row of its own and the band stands for it.
 * Rows are listed in hour order, which is why "the last row starting at or
 * before the hour" is always the one that holds it - and before the day's
 * first row (6 AM on a day that opens at 8) it is the first row.
 *
 * `rows` are the day's rows; `rowStartHours` the starting hour of every row
 * the planner renders, ascending; `hourOf` the shop-local hour of an ISO
 * instant. Null only when there are no rows to scroll to.
 */
export function nowAnchorHour(
  rows: readonly Pick<AgendaRow, "source" | "status" | "start" | "end">[],
  rowStartHours: readonly number[],
  hourOf: (iso: string) => number,
  now: number,
): number | null {
  const first = rowStartHours[0];
  if (first === undefined) return null;

  const live = rows
    .filter((r) => r.source !== "block" && r.status !== "canceled" && r.status !== "no_show")
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const inProgress = live.find(
    (r) => r.end !== null && Date.parse(r.start) <= now && now < Date.parse(r.end),
  );
  const next = live.find((r) => Date.parse(r.start) > now);
  const target = inProgress ?? next;
  const hour = hourOf(target ? target.start : new Date(now).toISOString());

  let anchor = first;
  for (const h of rowStartHours) if (h <= hour) anchor = h;
  return anchor;
}
