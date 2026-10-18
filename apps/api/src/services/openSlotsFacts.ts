import { prisma, runWithShop } from "@chairback/db";
import { apiEnv, zonedDateKey, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { bookNowUrl } from "@chairback/config/bookingLinks";
import type { OpenSlotsBrief, OpenSlotsDay } from "@chairback/config/openSlots";
import { computeOpenSlots } from "../engines/slots.js";
import { shopLocalDays } from "../engines/utilization.js";
import { PUBLIC_SERVICE } from "../engines/serviceVisibility.js";

/**
 * "How many slots do I have open next week?" - counted from the shop's own
 * calendar, for the Assistant (packages/config/openSlots.ts renders it).
 *
 * 🔴 NO NEW SLOT MATH. Every number is `computeOpenSlots`, the engine behind
 * the public booking page, so the count is the times a client could actually
 * pick: hours, breaks, blocked time, synced Acuity/Square visits, the booking
 * notice, how far ahead clients may book, and daily caps all apply.
 *
 * 🔴 WHAT ONE "OPEN TIME" IS: a start time the booking page offers for one
 * chair, for that chair's usual service - its most-booked public service over
 * the last 90 days (and what is already booked ahead), else the first public
 * service it offers. One service per chair, so a free half hour is counted
 * once, never once per service the way looping chairs x services (the MCP
 * calendar_openings tool) would.
 *
 * "Capacity" is the same engine with bookings left out (ignoreBooked): the
 * times the day would offer if nothing were booked. It is what tells a FULL
 * day from a CLOSED one.
 *
 * ChairBack booking only. A shop booking through Acuity, Square or its own
 * link has its open times in THAT calendar; ChairBack has no honest count to
 * give, so this returns null and the Assistant points there instead.
 */

const DAY = 24 * 60 * 60_000;
/** How far back "most-booked" looks. */
const USUAL_SERVICE_DAYS = 90;
/**
 * Bounded work. Each chair costs two slot-engine reads (open + capacity), each
 * one shop-scoped transaction; chairs are read a few at a time so a big team
 * cannot take the pool. Past this many chairs the count is not attempted
 * rather than given for some chairs and silently not others.
 */
export const OPEN_SLOTS_MAX_CHAIRS = 20;
const CHAIRS_AT_ONCE = 3;

export interface OpenSlotsScope {
  shopId: string;
  /** Set for one provider's own chair (a BARBER seat). */
  staffId?: string;
  now?: Date;
}

export type OpenSlotsResult =
  | { ok: true; brief: OpenSlotsBrief }
  | { ok: false; reason: "not_found" | "not_native" | "too_many_chairs" };

export async function collectOpenSlots(scope: OpenSlotsScope): Promise<OpenSlotsResult> {
  const now = scope.now ?? new Date();
  // Shop is read OUTSIDE runWithShop: it is RLS default-deny inside one.
  const shop = await prisma.shop.findUnique({
    where: { id: scope.shopId },
    select: { timezone: true, bookingMode: true, slug: true, publicPageEnabled: true, bookingUrl: true },
  });
  if (!shop) return { ok: false, reason: "not_found" };
  if (shop.bookingMode !== "native") return { ok: false, reason: "not_native" };
  const tz = shop.timezone;

  // Today through the Sunday of next week, in the shop's own calendar.
  const today = zonedDateParts(now, tz);
  const sinceMonday = (today.weekday + 6) % 7;
  const lastOffset = 6 - sinceMonday + 7;
  const from = zonedWallTimeToUtc(today.year, today.month0, today.day, 0, tz);
  const to = zonedWallTimeToUtc(today.year, today.month0, today.day + lastOffset + 1, 0, tz);
  const days = shopLocalDays(from, new Date(to.getTime() - 1), tz);

  const chairs = await runWithShop(scope.shopId, async (tx) => {
    const staff = await tx.staff.findMany({
      where: { shopId: scope.shopId, active: true, ...(scope.staffId ? { id: scope.staffId } : {}) },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    if (staff.length === 0 || staff.length > OPEN_SLOTS_MAX_CHAIRS) return staff.length === 0 ? [] : null;
    const staffIds = staff.map((s) => s.id);
    const [offered, booked] = await Promise.all([
      tx.serviceStaff.findMany({
        where: { shopId: scope.shopId, staffId: { in: staffIds }, service: PUBLIC_SERVICE },
        select: {
          staffId: true,
          service: { select: { id: true, name: true, durationMin: true, sortOrder: true } },
        },
      }),
      tx.appointment.groupBy({
        by: ["staffId", "serviceId"],
        where: {
          shopId: scope.shopId,
          staffId: { in: staffIds },
          status: { not: "CANCELED" },
          startsAt: { gte: new Date(now.getTime() - USUAL_SERVICE_DAYS * DAY), lt: to },
        },
        _count: { _all: true },
      }),
    ]);
    const count = new Map(booked.map((b) => [`${b.staffId}:${b.serviceId}`, b._count._all]));
    return staff.map((s) => {
      const mine = offered
        .filter((o) => o.staffId === s.id)
        .map((o) => o.service)
        .sort(
          (a, b) =>
            (count.get(`${s.id}:${b.id}`) ?? 0) - (count.get(`${s.id}:${a.id}`) ?? 0) ||
            a.sortOrder - b.sortOrder ||
            a.name.localeCompare(b.name),
        );
      return { staffId: s.id, service: mine[0] ?? null };
    });
  });
  if (chairs === null) return { ok: false, reason: "too_many_chairs" };

  const open = new Map<string, number>();
  const capacity = new Map<string, number>();
  const tally = (into: Map<string, number>, slots: { startsAt: Date }[]) => {
    for (const s of slots) {
      const key = zonedDateKey(s.startsAt, tz);
      into.set(key, (into.get(key) ?? 0) + 1);
    }
  };
  // A chair offering no public service has nothing a client can book.
  const counted = chairs.filter((c) => c.service !== null);
  for (let i = 0; i < counted.length; i += CHAIRS_AT_ONCE) {
    await Promise.all(
      counted.slice(i, i + CHAIRS_AT_ONCE).map(async (c) => {
        const input = { shopId: scope.shopId, staffId: c.staffId, serviceId: c.service!.id, fromDate: from, toDate: to, now };
        const [free, all] = await Promise.all([
          computeOpenSlots(input),
          computeOpenSlots({ ...input, ignoreBooked: true }),
        ]);
        tally(open, free);
        tally(capacity, all);
      }),
    );
  }

  const out: OpenSlotsDay[] = days.map((d) => {
    const key = zonedDateKey(d.dayStartUtc, tz);
    const free = open.get(key) ?? 0;
    // Bookings can only take times away, but a booking that ends off the grid
    // shifts where the next start falls, so never report fewer offered than open.
    return { date: key, weekday: d.weekday, open: free, capacity: Math.max(free, capacity.get(key) ?? 0) };
  });
  const services = new Set(counted.map((c) => c.service!.id));
  const only = services.size === 1 ? counted[0]!.service! : null;

  return {
    ok: true,
    brief: {
      scope: scope.staffId ? "own" : "shop",
      today: zonedDateKey(now, tz),
      days: out,
      chairs: counted.length,
      service: only ? `${only.name} (${only.durationMin} min)` : null,
      bookingUrl: bookNowUrl(shop, apiEnv().APP_BASE_URL),
    },
  };
}
