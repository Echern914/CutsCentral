import { prisma, runWithShop } from "@chairback/db";
import type { BookedOutFacts } from "../engines/bookedOut.js";
import { readChairEvents, minutesIntoLocalDay, type ChairEvent } from "../engines/insightsWindow.js";
import { openMinutesForDay, shopLocalDays } from "../engines/utilization.js";

/**
 * Count the numbers engines/bookedOut.ts reads - for the whole shop, or for one
 * provider's own book.
 *
 * 🔴 NO NEW DEFINITIONS. Every number here is read the way Insights reads it,
 * so the Assistant never contradicts the Insights tab:
 *   - bookings are `readChairEvents` (native + synced, the one revenue/visit
 *     reader; a provider's own view is native rows only, since a synced visit
 *     carries no staff);
 *   - open time is `openMinutesForDay`, the chair-time engine, with the same
 *     inputs the utilization route passes - including leaving out a block of
 *     SOME services, which keeps the time open for the rest (#642);
 *   - booked minutes count every booking that held the time, no-shows
 *     included, exactly as chair time does.
 *
 * Shop is read OUTSIDE runWithShop: Shop is RLS default-deny inside a shop
 * transaction and reads back null there.
 */

const DAY = 24 * 60 * 60_000;
/** A booking with no end still held the time. Same default as chair time. */
const DEFAULT_MIN = 30;

export interface BookedOutScope {
  shopId: string;
  /** Set for one provider's own view (a BARBER seat). */
  staffId?: string;
  now?: Date;
}

export async function collectBookedOutFacts(scope: BookedOutScope): Promise<BookedOutFacts | null> {
  const now = scope.now ?? new Date();
  const shop = await prisma.shop.findUnique({
    where: { id: scope.shopId },
    select: {
      timezone: true,
      bookingMode: true,
      publicPageEnabled: true,
      bio: true,
      heroImageUrl: true,
      galleryItems: true,
      instagramHandle: true,
      googleReviewUrl: true,
      waitlistEnabled: true,
      bookingLeadHours: true,
      bookingMaxDays: true,
      rewardsEnabled: true,
    },
  });
  if (!shop) return null;
  const tz = shop.timezone;
  const own = Boolean(scope.staffId);
  const staffFilter = scope.staffId ? { staffId: scope.staffId } : {};

  // The local calendar: 56 finished days behind, today, 13 days ahead.
  const days = shopLocalDays(new Date(now.getTime() - 56 * DAY), new Date(now.getTime() + 13 * DAY), tz);
  const fetchFrom = new Date(now.getTime() - 366 * DAY);
  const fetchTo = new Date(now.getTime() + 15 * DAY);

  const data = await runWithShop(scope.shopId, async (tx) => {
    const staff = await tx.staff.findMany({
      where: { shopId: scope.shopId, active: true, ...(scope.staffId ? { id: scope.staffId } : {}) },
      select: { id: true, imageUrl: true },
    });
    const staffIds = staff.map((s) => s.id);
    const [rules, recurringBlocks, exceptions, externalBlocks, services, offered, chair] = await Promise.all([
      tx.availabilityRule.findMany({
        where: { shopId: scope.shopId, ...staffFilter },
        select: { staffId: true, weekday: true, startMin: true, endMin: true },
      }),
      tx.recurringBlock.findMany({
        where: { shopId: scope.shopId, ...staffFilter },
        select: { staffId: true, weekday: true, startMin: true, endMin: true },
      }),
      tx.availabilityException.findMany({
        where: {
          shopId: scope.shopId,
          ...staffFilter,
          startsAt: { lt: fetchTo },
          endsAt: { gt: new Date(now.getTime() - 58 * DAY) },
          // A block of SOME services keeps the time open for the rest.
          OR: [{ isBlock: false }, { serviceIds: { isEmpty: true } }],
        },
        select: { staffId: true, startsAt: true, endsAt: true, isBlock: true },
      }),
      tx.externalBlock.findMany({
        where: { shopId: scope.shopId, startsAt: { lt: fetchTo }, endsAt: { gt: new Date(now.getTime() - 58 * DAY) } },
        select: { startsAt: true, endsAt: true },
      }),
      tx.service.findMany({
        where: { shopId: scope.shopId, active: true },
        select: { id: true, price: true },
      }),
      scope.staffId
        ? tx.serviceStaff.findMany({
            where: { shopId: scope.shopId, staffId: scope.staffId },
            select: { serviceId: true },
          })
        : Promise.resolve(null),
      readChairEvents(scope.shopId, fetchFrom, fetchTo, { ...staffFilter, tx }),
    ]);

    // First-ever booking for every client seen in the last 60 days - "new".
    const recentIds = [
      ...new Set(
        chair.events
          .filter((e) => e.clientId && e.start <= now && e.start.getTime() >= now.getTime() - 60 * DAY)
          .map((e) => e.clientId!),
      ),
    ];
    const [firstAppts, firstVisits, hiddenClients] =
      recentIds.length === 0 && chair.events.length === 0
        ? [[], [], []]
        : await Promise.all([
            recentIds.length === 0
              ? Promise.resolve([])
              : tx.appointment.groupBy({
                  by: ["clientId"],
                  where: {
                    shopId: scope.shopId,
                    ...staffFilter,
                    holdExpiresAt: null,
                    status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] },
                    clientId: { in: recentIds },
                  },
                  _min: { startsAt: true },
                }),
            // A provider's own "new" is new to THEM; synced visits carry no staff.
            own || recentIds.length === 0
              ? Promise.resolve([])
              : tx.visit.groupBy({
                  by: ["clientId"],
                  where: {
                    shopId: scope.shopId,
                    status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] },
                    clientId: { in: recentIds },
                  },
                  _min: { scheduledAt: true },
                }),
            // Archived and blocked clients are nobody to win back.
            tx.client.findMany({
              where: {
                shopId: scope.shopId,
                OR: [{ archivedAt: { not: null } }, { bookingBlockedAt: { not: null } }],
              },
              select: { id: true },
            }),
          ]);

    return { staff, staffIds, rules, recurringBlocks, exceptions, externalBlocks, services, offered, chair, firstAppts, firstVisits, hiddenClients };
  });

  const { staff, staffIds, rules, recurringBlocks, exceptions, externalBlocks, chair } = data;
  const events = chair.events;
  const nowMin = minutesIntoLocalDay(now, tz);
  const todayMs = localDayStart(now, days);

  const openFor = (d: { dayStartUtc: Date; weekday: number }, untilMin?: number) =>
    openMinutesForDay({
      dayStartUtc: d.dayStartUtc,
      weekday: d.weekday,
      staffIds,
      rules,
      recurringBlocks,
      exceptions,
      externalBlocks,
      ...(untilMin !== undefined ? { untilMin } : {}),
    });
  const minutesOf = (e: ChairEvent) =>
    e.end && e.end > e.start ? Math.round((e.end.getTime() - e.start.getTime()) / 60_000) : DEFAULT_MIN;

  // Coming 14 days: the rest of today, then 13 whole days.
  let upOpen = 0;
  for (const d of days) {
    const t = d.dayStartUtc.getTime();
    if (t < todayMs) continue;
    upOpen += t === todayMs ? openFor(d) - openFor(d, nowMin) : openFor(d);
  }
  const upEnd = todayMs + 14 * DAY;
  const upBooked = events
    .filter((e) => e.start >= now && e.start.getTime() < upEnd)
    .reduce((s, e) => s + minutesOf(e), 0);

  // Last 28 finished days, and the last 56 by weekday.
  let pastOpen = 0;
  const wk = new Map<number, { openMin: number; bookedMin: number; days: number }>();
  const dayOf = new Map<number, number>(); // local day start -> weekday
  for (const d of days) {
    const t = d.dayStartUtc.getTime();
    if (t >= todayMs) continue;
    const open = openFor(d);
    dayOf.set(t, d.weekday);
    if (t >= todayMs - 28 * DAY) pastOpen += open;
    if (open > 0) {
      const w = wk.get(d.weekday) ?? { openMin: 0, bookedMin: 0, days: 0 };
      w.openMin += open;
      w.days += 1;
      wk.set(d.weekday, w);
    }
  }
  let pastBooked = 0;
  for (const e of events) {
    const t = e.start.getTime();
    if (t >= todayMs || t < todayMs - 56 * DAY) continue;
    const start = dayStartOf(t, days);
    if (start === null) continue;
    if (t >= todayMs - 28 * DAY) pastBooked += minutesOf(e);
    const w = wk.get(dayOf.get(start) ?? -1);
    if (w) w.bookedMin += minutesOf(e);
  }

  // Visits that happened (not no-shows), per client, in time order.
  const byClient = new Map<string, number[]>();
  const future = new Set<string>();
  for (const e of events) {
    if (!e.clientId) continue;
    if (e.start > now) {
      future.add(e.clientId);
      continue;
    }
    if (e.noShow) continue;
    const list = byClient.get(e.clientId) ?? [];
    list.push(e.start.getTime());
    byClient.set(e.clientId, list);
  }
  const hidden = new Set(data.hiddenClients.map((c) => c.id));

  // Coming back: clients seen 6-13 weeks ago, back within 6 weeks of that visit.
  const allStarts = new Map<string, number[]>(); // incl. booked-ahead, for "came back or is booked"
  for (const e of events) {
    if (!e.clientId || e.noShow) continue;
    const list = allStarts.get(e.clientId) ?? [];
    list.push(e.start.getTime());
    allStarts.set(e.clientId, list);
  }
  let cohort = 0;
  let returned = 0;
  const lo = now.getTime() - 91 * DAY;
  const hi = now.getTime() - 42 * DAY;
  for (const [clientId, starts] of byClient) {
    if (hidden.has(clientId)) continue;
    const inWindow = starts.filter((t) => t >= lo && t < hi);
    if (inWindow.length === 0) continue;
    const last = Math.max(...inWindow);
    cohort += 1;
    if ((allStarts.get(clientId) ?? []).some((t) => t > last && t <= last + 42 * DAY)) returned += 1;
  }

  // Overdue regulars: 3+ visits in the year, past their own median gap by half
  // again (and a week at least), not lost (under 6 months), nothing booked.
  let overdue = 0;
  for (const [clientId, starts] of byClient) {
    if (hidden.has(clientId) || future.has(clientId) || starts.length < 3) continue;
    const sorted = [...starts].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => (t - sorted[i]!) / DAY).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)]!;
    if (!(median > 0)) continue;
    const since = (now.getTime() - sorted[sorted.length - 1]!) / DAY;
    if (since > Math.max(median * 1.5, median + 7) && since <= 180) overdue += 1;
  }

  // New clients: first-ever booking in each 30-day window.
  const firstEver = new Map<string, number>();
  const note = (id: string | null, at: Date | null) => {
    if (!id || !at) return;
    const prev = firstEver.get(id);
    if (prev === undefined || at.getTime() < prev) firstEver.set(id, at.getTime());
  };
  for (const f of data.firstAppts as { clientId: string | null; _min: { startsAt: Date | null } }[]) note(f.clientId, f._min.startsAt);
  for (const f of data.firstVisits as { clientId: string | null; _min: { scheduledAt: Date | null } }[]) note(f.clientId, f._min.scheduledAt);
  let last30 = 0;
  let prior30 = 0;
  for (const at of firstEver.values()) {
    if (at > now.getTime()) continue;
    if (at >= now.getTime() - 30 * DAY) last30 += 1;
    else if (at >= now.getTime() - 60 * DAY) prior30 += 1;
  }

  // No-shows over the last 60 days of past bookings.
  const past60 = events.filter((e) => e.start <= now && e.start.getTime() >= now.getTime() - 60 * DAY);

  // Services this view sells.
  const offeredIds = data.offered ? new Set(data.offered.map((o) => o.serviceId)) : null;
  const sold = data.services.filter((s) => !offeredIds || offeredIds.has(s.id));

  const gallery = Array.isArray(shop.galleryItems) ? shop.galleryItems.length : 0;
  const hasHours = rules.length > 0;

  return {
    scope: own ? "own" : "shop",
    bookingMode: shop.bookingMode,
    upcoming: hasHours ? { openMin: upOpen, bookedMin: upBooked } : shop.bookingMode === "native" ? { openMin: 0, bookedMin: upBooked } : null,
    past: hasHours ? { openMin: pastOpen, bookedMin: pastBooked } : null,
    weekdays: hasHours ? [...wk.entries()].map(([weekday, w]) => ({ weekday, ...w })) : [],
    returning: { cohort, returned },
    newClients: { last30, prior30 },
    noShows: { bookings: past60.length, noShows: past60.filter((e) => e.noShow).length },
    overdueRegulars: overdue,
    page: own
      ? null
      : {
          publicPageEnabled: shop.publicPageEnabled,
          hasBio: Boolean(shop.bio?.trim()),
          hasHeroImage: Boolean(shop.heroImageUrl),
          galleryCount: gallery,
          hasInstagram: Boolean(shop.instagramHandle?.trim()),
          hasGoogleReviewUrl: Boolean(shop.googleReviewUrl?.trim()),
        },
    profileMissingPhoto: staff.filter((s) => !s.imageUrl).length,
    booking: {
      leadHours: shop.bookingLeadHours,
      maxDays: shop.bookingMaxDays,
      waitlistEnabled: shop.waitlistEnabled,
    },
    rewardsEnabled: shop.rewardsEnabled,
    services: { total: sold.length, unpriced: sold.filter((s) => s.price === null).length },
  };
}

/** The local-day start (UTC ms) of the day containing `now`, from the walked days. */
function localDayStart(now: Date, days: { dayStartUtc: Date }[]): number {
  let best = days[0]!.dayStartUtc.getTime();
  for (const d of days) if (d.dayStartUtc.getTime() <= now.getTime()) best = d.dayStartUtc.getTime();
  return best;
}

/** Which walked local day an instant falls in, by its start (UTC ms). */
function dayStartOf(t: number, days: { dayStartUtc: Date }[]): number | null {
  let found: number | null = null;
  for (const d of days) {
    const s = d.dayStartUtc.getTime();
    if (s <= t) found = s;
    else break;
  }
  return found;
}
