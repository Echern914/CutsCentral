import { Prisma, runWithShop } from "@chairback/db";
import { zonedDateKey } from "@chairback/config";
import {
  MAX_DATE_HOURS_DATES,
  MAX_DATE_HOURS_NAME,
  parseDateHours,
  parseDateOverrides,
  serializeDateHours,
  type StoredDateHours,
} from "@chairback/config/servicePricing";

/**
 * "ON THESE DAYS, THIS SERVICE IS OPEN THESE HOURS" - the one writer of
 * Service.dateHours.
 *
 * A barber picks several dates at once (the days of Thanksgiving week) and
 * says what one service's hours are on them. What that MEANS is decided in the
 * slot engine (engines/slots.ts: a dated entry replaces the day for that
 * service); this only records it.
 *
 * 🔴 MERGED UNDER A ROW LOCK, never written whole from the browser. The column
 * is one JSON map for every date, so two saves a moment apart - two tabs, a
 * double tap that changed its mind - would each send "the map as I last saw
 * it" and the second would erase the first's dates. Here each save names only
 * the dates it is about, and they are folded into the row as it stands now.
 *
 * Past dates are dropped on every save (shop-local, so "today" is the shop's
 * today), which keeps the map from growing for ever and is harmless: nothing
 * resolves against a day that is over.
 *
 * An optional price rides along, into the existing per-date price layer
 * (Service.dateOverrides) - there is one holiday-price rule and this does not
 * add a second.
 */

export type DateHoursRefusal =
  | "not_found"
  | "past_date"
  | "overlapping_hours"
  | "unknown_staff"
  | "too_many_dates";

export interface DateHoursChange {
  /** Shop-local "YYYY-MM-DD" dates this save is about. */
  dates: string[];
  /** The hours on those dates. [] = not offered. null = back to the usual week. */
  hours: { s: number; e: number }[] | null;
  /** Who it applies to. Absent or [] = everyone who offers the service. */
  staffIds?: string[];
  /** A price for those dates; null clears it; absent leaves prices alone. */
  price?: number | null;
  /**
   * What the shop calls the change. "" clears it. ABSENT KEEPS whatever name
   * each date already has, so changing a named day's hours does not unname it.
   */
  name?: string;
}

export type DateHoursOutcome =
  | { ok: true; dateHours: StoredDateHours; dateOverrides: Record<string, number> }
  | { ok: false; error: DateHoursRefusal };

/** The same cap the per-date price layer has always had (booking.dashboard.ts). */
const MAX_DATE_PRICES = 120;

export async function setServiceDateHours(opts: {
  shopId: string;
  serviceId: string;
  timezone: string;
  change: DateHoursChange;
  now: Date;
}): Promise<DateHoursOutcome> {
  const { shopId, serviceId, timezone, change, now } = opts;
  const today = zonedDateKey(now, timezone);
  const dates = [...new Set(change.dates)];
  // String order IS date order for YYYY-MM-DD.
  if (dates.some((d) => d < today)) return { ok: false, error: "past_date" };

  const hours = change.hours === null ? null : [...change.hours].sort((a, b) => a.s - b.s || a.e - b.e);
  if (hours) {
    for (let i = 1; i < hours.length; i++) {
      // Touching is fine (3:30 to 3:30); sharing a minute is a typo to send back.
      if (hours[i]!.s < hours[i - 1]!.e) return { ok: false, error: "overlapping_hours" };
    }
  }
  const staffIds = [...new Set(change.staffIds ?? [])];
  const name = change.name === undefined ? undefined : change.name.trim().slice(0, MAX_DATE_HOURS_NAME);

  return runWithShop(shopId, async (tx): Promise<DateHoursOutcome> => {
    const rows = await tx.$queryRaw<{ dateHours: unknown; dateOverrides: unknown }[]>(Prisma.sql`
      SELECT "dateHours", "dateOverrides" FROM "Service"
      WHERE "id" = ${serviceId} AND "shopId" = ${shopId}
      FOR UPDATE`);
    const row = rows[0];
    if (!row) return { ok: false, error: "not_found" };

    // Only people who actually do this service can be named: an entry for
    // anyone else would never apply to a grid and would sit there confusing.
    if (staffIds.length > 0) {
      const offers = await tx.serviceStaff.findMany({
        where: { shopId, serviceId, staffId: { in: staffIds } },
        select: { staffId: true },
      });
      if (new Set(offers.map((o) => o.staffId)).size !== staffIds.length) {
        return { ok: false, error: "unknown_staff" };
      }
    }

    const map = parseDateHours(row.dateHours);
    for (const key of [...map.keys()]) if (key < today) map.delete(key);
    for (const date of dates) {
      if (hours === null) map.delete(date);
      else {
        const called = name === undefined ? map.get(date)?.name : name;
        map.set(date, {
          windows: hours.map((h) => ({ startMin: h.s, endMin: h.e })),
          staffIds,
          ...(called ? { name: called } : {}),
        });
      }
    }
    if (map.size > MAX_DATE_HOURS_DATES) return { ok: false, error: "too_many_dates" };
    // Through the parser once more, so what is stored is exactly what the
    // engine will read back (touching windows merged, dates in order).
    const dateHours = serializeDateHours(parseDateHours(serializeDateHours(map)));

    const prices = parseDateOverrides(row.dateOverrides);
    if (change.price !== undefined) {
      for (const date of dates) {
        if (change.price === null) delete prices[date];
        else prices[date] = change.price;
      }
      if (Object.keys(prices).length > MAX_DATE_PRICES) return { ok: false, error: "too_many_dates" };
    }

    await tx.service.updateMany({
      where: { id: serviceId, shopId },
      data: {
        dateHours,
        ...(change.price !== undefined ? { dateOverrides: prices } : {}),
      },
    });
    return { ok: true, dateHours, dateOverrides: prices };
  });
}

/**
 * NAME A CHANGE THAT IS ALREADY THERE ("Thanksgiving week"), or take its name
 * off with "". Hours, staff and prices are not touched.
 *
 * Under the same row lock as the hours writer, and for the same reason: the
 * column is one map, and a name written from "the map as the browser last saw
 * it" would put back hours another save had just changed.
 *
 * A date with no entry is SKIPPED, not refused: there is nothing there to
 * name, and a day the barber undid in another tab a moment ago is not an
 * error worth showing. A past date is skipped the same way.
 */
export async function nameServiceDateHours(opts: {
  shopId: string;
  serviceId: string;
  timezone: string;
  dates: string[];
  name: string;
  now: Date;
}): Promise<{ ok: true; dateHours: StoredDateHours } | { ok: false; error: "not_found" }> {
  const { shopId, serviceId, timezone, now } = opts;
  const today = zonedDateKey(now, timezone);
  const name = opts.name.trim().slice(0, MAX_DATE_HOURS_NAME);
  return runWithShop(shopId, async (tx) => {
    const rows = await tx.$queryRaw<{ dateHours: unknown }[]>(Prisma.sql`
      SELECT "dateHours" FROM "Service"
      WHERE "id" = ${serviceId} AND "shopId" = ${shopId}
      FOR UPDATE`);
    const row = rows[0];
    if (!row) return { ok: false as const, error: "not_found" as const };
    const map = parseDateHours(row.dateHours);
    for (const key of [...map.keys()]) if (key < today) map.delete(key);
    for (const date of new Set(opts.dates)) {
      const entry = map.get(date);
      if (!entry) continue;
      const { name: _old, ...rest } = entry;
      map.set(date, name ? { ...rest, name } : rest);
    }
    const dateHours = serializeDateHours(parseDateHours(serializeDateHours(map)));
    await tx.service.updateMany({ where: { id: serviceId, shopId }, data: { dateHours } });
    return { ok: true as const, dateHours };
  });
}
