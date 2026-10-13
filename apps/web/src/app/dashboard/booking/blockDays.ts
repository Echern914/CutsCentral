import { zonedDateKey, zonedWallTimeToUtc } from "@chairback/config/time";
import { addDaysToKey } from "./blockOffDates";

/** The longest a block is spread for display - a year and a day. */
const MAX_SPREAD_DAYS = 367;

/**
 * A blocked span as the DAY VIEW needs it: one piece per shop-local day it
 * covers, each clipped to that day's midnights.
 *
 * The calendar buckets rows by the day they START on, and the day planner
 * reads a band's hours from its start and end wall clock. A block that runs
 * past midnight - an old single-row vacation, or any block that began before
 * the loaded window (the agenda now returns those too) - therefore showed only
 * on its first day, and there with the wrong end. Spread, each day gets its
 * own piece: the first from the block's start to midnight, whole days between,
 * the last from midnight to the block's end. Every piece keeps the block's id,
 * so opening any of them opens the one block.
 *
 * Anything that is not a block, or a block that ends by the next midnight,
 * comes back as itself.
 */
export function spreadAcrossDays<T extends { source: string; start: string; end?: string | null }>(
  row: T,
  timezone: string,
): T[] {
  if (row.source !== "block" || !row.end) return [row];
  const start = Date.parse(row.start);
  const end = Date.parse(row.end);
  if (!(end > start)) return [row];
  const firstKey = zonedDateKey(new Date(start), timezone);
  const midnightAfter = (key: string) => {
    const next = addDaysToKey(key, 1);
    const [y, m, d] = next.split("-").map(Number);
    return zonedWallTimeToUtc(y!, m! - 1, d!, 0, timezone).getTime();
  };
  if (end <= midnightAfter(firstKey)) return [row];

  const pieces: T[] = [];
  let key = firstKey;
  let from = start;
  for (let i = 0; i < MAX_SPREAD_DAYS && from < end; i++) {
    const until = Math.min(end, midnightAfter(key));
    if (until > from) {
      pieces.push({ ...row, start: new Date(from).toISOString(), end: new Date(until).toISOString() });
    }
    from = until;
    key = addDaysToKey(key, 1);
  }
  return pieces;
}
