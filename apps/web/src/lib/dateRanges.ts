/**
 * Pure YYYY-MM-DD range math for the holiday-pricing editor.
 *
 * Everything here is CALENDAR arithmetic on date keys, done in UTC on
 * purpose: a holiday is a shop-local calendar date, not an instant, so DST
 * must never be able to skip or double a day (constructing local-midnight
 * Dates is exactly how a spring-forward day goes missing).
 */

/** Guard against a fat-fingered year: one staged range tops out at 62 days
 *  (two months - covers any holiday stretch a shop would actually price). */
export const MAX_RANGE_DAYS = 62;

function toUtc(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function toKey(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** The calendar day after `key` ("2026-12-31" -> "2027-01-01"). */
export function nextDay(key: string): string {
  return toKey(toUtc(key) + 24 * 60 * 60 * 1000);
}

/**
 * Every date from `from` to `to` INCLUSIVE ("Dec 25-31" prices seven days).
 * A backwards or over-long range returns null so the caller can refuse it
 * with words instead of silently pricing something else.
 */
export function expandRange(from: string, to: string): string[] | null {
  const a = toUtc(from);
  const b = toUtc(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const days = Math.round((b - a) / (24 * 60 * 60 * 1000)) + 1;
  if (days > MAX_RANGE_DAYS) return null;
  const out: string[] = [];
  for (let t = a; t <= b; t += 24 * 60 * 60 * 1000) out.push(toKey(t));
  return out;
}

/**
 * Collapse a set of dates back into contiguous runs, soonest first - the
 * inverse of expandRange, so seven staged days render as ONE "Dec 25 - 31"
 * chip rather than seven, and removing the chip removes the whole run.
 */
export function collapseRuns(dates: string[]): { from: string; to: string }[] {
  const sorted = [...new Set(dates)].sort();
  const runs: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextDay(last.to) === d) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}
