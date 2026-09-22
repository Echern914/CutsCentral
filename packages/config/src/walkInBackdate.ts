import { zonedDateParts, zonedWallTimeToUtc } from "./time.js";

/**
 * HOW FAR BACK A WALK-IN CAN BE DATED, as ONE rule the API enforces and the
 * dashboard's time field mirrors. Browser-safe (Intl only).
 *
 * The window is counted in the SHOP's calendar days: a walk-in may be dated
 * from local midnight of the day 30 days before today, up to (not including)
 * now. It is deliberately NOT `now - 30 * 24h`. Whenever a DST change falls
 * inside the window those two differ by an hour, and the calendar is what a
 * barber means by "30 days back" - so that is what both sides count.
 */
export const WALK_IN_BACKDATE_MAX_DAYS = 30;

/** Why a time cannot date a walk-in - the API's error codes, verbatim. */
export type WalkInBackdateRefusal = "occurred_at_not_in_past" | "occurred_at_too_old";

/**
 * The first instant a walk-in recorded at `now` may be dated at: the start of
 * the shop-local day WALK_IN_BACKDATE_MAX_DAYS calendar days before `now`'s
 * shop-local date.
 */
export function earliestWalkInBackdate(now: Date, timeZone: string): Date {
  const today = zonedDateParts(now, timeZone);
  // Calendar arithmetic on the DATE; Date.UTC carries a day underflow across
  // month and year ends.
  const first = new Date(Date.UTC(today.year, today.month0, today.day - WALK_IN_BACKDATE_MAX_DAYS));
  const year = first.getUTCFullYear();
  const month0 = first.getUTCMonth();
  const day = first.getUTCDate();
  const start = zonedWallTimeToUtc(year, month0, day, 0, timeZone);
  // Where a zone springs forward AT midnight (Chile, Cuba), 00:00 does not
  // exist and the conversion lands an hour early, on the day before. That
  // day's first real instant is the hour after.
  const landed = zonedDateParts(start, timeZone);
  return landed.year === year && landed.month0 === month0 && landed.day === day
    ? start
    : new Date(start.getTime() + 60 * 60_000);
}

/** Why `at` cannot date a walk-in recorded at `now`, or null when it can. */
export function walkInBackdateRefusal(
  at: Date,
  now: Date,
  timeZone: string,
): WalkInBackdateRefusal | null {
  // Written as "not before now" so an invalid Date is refused too.
  if (!(at.getTime() < now.getTime())) return "occurred_at_not_in_past";
  if (at.getTime() < earliestWalkInBackdate(now, timeZone).getTime()) return "occurred_at_too_old";
  return null;
}
