/**
 * Pure time/stat helpers used by the cadence engine. No I/O, no Date.now() —
 * callers pass timestamps in, so these stay deterministic and unit-testable.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Whole-day difference between two dates (later - earlier), rounded. */
export function dayDiff(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

/**
 * Gaps in days between consecutive dates. Input is sorted ascending first, so
 * callers don't have to pre-sort. Returns [] for fewer than 2 dates.
 */
export function dayGaps(dates: Date[]): number[] {
  if (dates.length < 2) return [];
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(dayDiff(sorted[i - 1]!, sorted[i]!));
  }
  return gaps;
}

/**
 * Median of a list of numbers. Median (not mean) resists outliers — a client
 * with one freak 90-day gap shouldn't skew their cadence. Returns null for [].
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Add whole days to a date, returning a new Date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
