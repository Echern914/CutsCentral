import { runWithShop } from "@chairback/db";
import { addDays, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";

/**
 * Blocked time, answered once for everyone: the concrete UTC ranges during
 * which a given staff member is NOT to be booked, from all three sources —
 *
 *   - AvailabilityException rows with isBlock (one-off "I'm away 12-3"),
 *   - RecurringBlock rows (standing weekly breaks), walked per shop-local date
 *     so DST resolves exactly like the availability windows they carve,
 *   - ExternalBlock rows (time blocked in Acuity/Square; carries no staff, so
 *     it blocks every chair).
 *
 * computeOpenSlots already subtracts all three from the GRID. This module
 * exists for the surfaces the grid does not cover — above all TARGETED slots,
 * which deliberately bypass hours/lead/max ("my 9pm special") and used to
 * bypass blocks with them. That was the vacation-week bug: a weekly special
 * kept publishing bookable chips straight through the barber's blocked days.
 * BLOCKED TIME ALWAYS WINS over a published special: hours say when he
 * normally works; a block says he is NOT THERE. The special is standing
 * inventory; the block is the more recent, more specific fact.
 *
 * Everything here is read-only and reversible: unblock the day and the same
 * specials simply reappear — nothing is deactivated or deleted.
 */

export interface BlockRange {
  start: number; // epoch ms
  end: number; // epoch ms
}

/**
 * Walk weekday-keyed local-minute windows across [fromMs, toMs] and return
 * concrete UTC ranges, one per shop-local date the weekday hits. The walk pads
 * a day on each side so a window straddling UTC midnight is still captured,
 * and converts each edge with zonedWallTimeToUtc so DST lands per-instant.
 * Same math the slots engine uses for its windows — extracted so the two can
 * never drift.
 */
export function weekdayWindowsToRanges(
  windows: { weekday: number; startMin: number; endMin: number }[],
  fromMs: number,
  toMs: number,
  timezone: string,
): BlockRange[] {
  const byWeekday = new Map<number, { startMin: number; endMin: number }[]>();
  for (const w of windows) {
    if (w.endMin <= w.startMin) continue; // defensive: never a negative range
    const list = byWeekday.get(w.weekday) ?? [];
    list.push({ startMin: w.startMin, endMin: w.endMin });
    byWeekday.set(w.weekday, list);
  }
  if (byWeekday.size === 0) return [];

  const out: BlockRange[] = [];
  let cursor = addDays(new Date(fromMs), -1);
  const walkEnd = addDays(new Date(toMs), 1);
  while (cursor.getTime() <= walkEnd.getTime()) {
    const parts = zonedDateParts(cursor, timezone);
    const dayWindows = byWeekday.get(parts.weekday);
    if (dayWindows) {
      for (const w of dayWindows) {
        const start = zonedWallTimeToUtc(
          parts.year,
          parts.month0,
          parts.day,
          w.startMin,
          timezone,
        );
        const end = zonedWallTimeToUtc(
          parts.year,
          parts.month0,
          parts.day,
          w.endMin,
          timezone,
        );
        out.push({ start: start.getTime(), end: end.getTime() });
      }
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Pad (ms) on the DB reads so a block straddling the range edge is caught. */
const READ_PAD_MS = 24 * 60 * 60_000;

/**
 * The blocked ranges for each of `staffIds` over [fromMs, toMs], from all
 * three sources. External blocks are shop-wide and appear in every staff's
 * list. One shop-scoped transaction for all reads; the walking happens outside
 * it. Duplicate staff ids are fine; unknown ids come back with just the
 * shop-wide blocks.
 */
export async function blockedRangesByStaff(input: {
  shopId: string;
  staffIds: string[];
  fromMs: number;
  toMs: number;
  timezone: string;
}): Promise<Map<string, BlockRange[]>> {
  const staffIds = [...new Set(input.staffIds)];
  const map = new Map<string, BlockRange[]>();
  if (staffIds.length === 0 || input.toMs <= input.fromMs) return map;

  const data = await runWithShop(input.shopId, async (tx) => {
    const [exceptions, recurring, external] = await Promise.all([
      tx.availabilityException.findMany({
        where: {
          shopId: input.shopId,
          staffId: { in: staffIds },
          isBlock: true,
          startsAt: { lt: new Date(input.toMs + READ_PAD_MS) },
          endsAt: { gt: new Date(input.fromMs - READ_PAD_MS) },
        },
        select: { staffId: true, startsAt: true, endsAt: true },
      }),
      tx.recurringBlock.findMany({
        where: { shopId: input.shopId, staffId: { in: staffIds } },
        select: { staffId: true, weekday: true, startMin: true, endMin: true },
      }),
      tx.externalBlock.findMany({
        where: {
          shopId: input.shopId,
          startsAt: { lt: new Date(input.toMs + READ_PAD_MS) },
          endsAt: { gt: new Date(input.fromMs - READ_PAD_MS) },
        },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    return { exceptions, recurring, external };
  });

  const shopWide: BlockRange[] = data.external.map((b) => ({
    start: b.startsAt.getTime(),
    end: b.endsAt.getTime(),
  }));

  for (const staffId of staffIds) {
    const ranges: BlockRange[] = [...shopWide];
    for (const ex of data.exceptions) {
      if (ex.staffId === staffId) {
        ranges.push({ start: ex.startsAt.getTime(), end: ex.endsAt.getTime() });
      }
    }
    ranges.push(
      ...weekdayWindowsToRanges(
        data.recurring.filter((r) => r.staffId === staffId),
        input.fromMs,
        input.toMs,
        input.timezone,
      ),
    );
    map.set(staffId, ranges);
  }
  return map;
}

/** True when [startMs, endMs) overlaps any blocked range (half-open). */
export function spanIsBlocked(
  ranges: BlockRange[] | undefined,
  startMs: number,
  endMs: number,
): boolean {
  if (!ranges) return false;
  return ranges.some((r) => r.start < endMs && r.end > startMs);
}

/**
 * Convenience for the write path: is this one staff member blocked anywhere in
 * [startsAt, endsAt)? Reads only what the single check needs.
 */
export async function staffSpanBlocked(input: {
  shopId: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}): Promise<boolean> {
  const map = await blockedRangesByStaff({
    shopId: input.shopId,
    staffIds: [input.staffId],
    fromMs: input.startsAt.getTime(),
    toMs: input.endsAt.getTime(),
    timezone: input.timezone,
  });
  return spanIsBlocked(
    map.get(input.staffId),
    input.startsAt.getTime(),
    input.endsAt.getTime(),
  );
}

/**
 * Filter helper for the read surfaces: keep only the targeted slots whose span
 * touches no blocked time for their own staff. `slots` may span several staff
 * members (the /day payload does); the map must have been built for at least
 * those ids and the covering time range.
 */
export function dropBlockedTargetedSlots<
  T extends { staffId: string; startsAt: Date; durationMin: number },
>(slots: T[], blocked: Map<string, BlockRange[]>): T[] {
  return slots.filter(
    (t) =>
      !spanIsBlocked(
        blocked.get(t.staffId),
        t.startsAt.getTime(),
        t.startsAt.getTime() + t.durationMin * 60_000,
      ),
  );
}
