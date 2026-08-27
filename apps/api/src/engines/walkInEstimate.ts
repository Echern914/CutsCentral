import { prisma } from "@chairback/db";
import {
  computeFreeRanges,
  subtractRanges,
  type TimeRange,
} from "./slots.js";
import { shopLocalDayWindow } from "./serviceDailyLimit.js";

/**
 * Walk-In Mode: THE wait-estimate engine. One deterministic answer, shared by
 * every surface - the kiosk quote, the customer's My Place in Line page, and
 * the barber board must never disagree about the same queue.
 *
 * HOW IT WORKS. Each active barber's REAL free time for the rest of the shop
 * day comes from computeFreeRanges - the exact busy set the public slot grid
 * reads (appointments hold-aware, waitlist holds, recurring and one-off
 * blocks, Acuity external blocks, synced visits, targeted slots), with
 * ignoreLeadTime because a walk-in can start now, and serviceId null because
 * the queue spans services. The queue is then simulated onto those timelines
 * greedily, in board order:
 *
 *   - IN_SERVICE entries consume NOTHING - their real Appointment already
 *     blocks the timeline (counting them again would double-book the
 *     simulation).
 *   - ASSIGNED / READY entries consume the first fit on their OWN chair.
 *   - WAITING entries take the earliest fit across their eligible barbers.
 *
 * Eligibility: active staff offering EVERY selected service (ServiceStaff is
 * materialized for offeredByAll services, so one join answers it). A hard
 * preference is honored hard - the customer is waiting FOR that barber - and
 * falls back to the full eligible set only when the preferred chair is gone
 * or inactive. An empty eligible set falls back to ALL active staff: a
 * combination nobody formally offers is still served by whoever takes it,
 * and "no estimate" would read as "you will never be served".
 *
 * DETERMINISM. Ties break lexicographically on (start instant, staffId asc).
 * Not load-balancing: a balancing heuristic reorders projections between two
 * polls of the same queue, which a customer watching their page reads as the
 * line jumping around. Same inputs, same answer, every time.
 *
 * `now` is a required parameter (the clock-tick rule). Every answer is an
 * ESTIMATE and every surface labels it as one - this engine predicts, the
 * overlap guard at service start decides.
 */

const MS_PER_MIN = 60_000;

export interface EntryForEstimate {
  id: string;
  status: string;
  position: number;
  joinedAt: Date;
  preferredStaffId: string | null;
  assignedStaffId: string | null;
  /** Sum of the entry's service duration snapshots (minutes). */
  totalDurationMin: number;
  serviceIds: string[];
}

export interface QueueEstimate {
  /** Which chair the simulation seated them at. null = no eligible chair
   * could fit them before the day ends. */
  projectedStaffId: string | null;
  /** Projected service start. null = "after close" (no fit today). */
  startsAt: Date | null;
  /** Whole minutes from `now` to the projected start. null with startsAt. */
  waitMin: number | null;
}

/** First instant >= from where durMs fits inside one free range. */
function findFit(
  timeline: TimeRange[],
  fromMs: number,
  durMs: number,
): number | null {
  for (const r of timeline) {
    const s = Math.max(r.start, fromMs);
    if (r.end - s >= durMs) return s;
  }
  return null;
}

export async function estimateQueue(opts: {
  shopId: string;
  now: Date;
  queue: EntryForEstimate[];
}): Promise<Map<string, QueueEstimate>> {
  const { shopId, now, queue } = opts;
  const out = new Map<string, QueueEstimate>();
  if (queue.length === 0) return out;

  // Shop config on the OWNER connection, before any scoped tx (Shop is
  // RLS-denied to the app role inside runWithShop).
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, bookingBufferMin: true },
  });
  if (!shop) return out;
  const buffer = Math.max(0, shop.bookingBufferMin);
  const dayEnd = shopLocalDayWindow(now, shop.timezone).end;

  // Eligibility inputs. Plain reads (no tenant writes here); the whole
  // simulation below is pure once these and the timelines are in hand.
  const allServiceIds = [...new Set(queue.flatMap((e) => e.serviceIds))];
  const [staffRows, offerRows] = await Promise.all([
    prisma.staff.findMany({
      where: { shopId, active: true },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    allServiceIds.length > 0
      ? prisma.serviceStaff.findMany({
          where: { shopId, serviceId: { in: allServiceIds } },
          select: { serviceId: true, staffId: true },
        })
      : Promise.resolve([]),
  ]);
  const staffIds = staffRows.map((s) => s.id);
  if (staffIds.length === 0) {
    for (const e of queue) {
      out.set(e.id, { projectedStaffId: null, startsAt: null, waitMin: null });
    }
    return out;
  }
  const offers = new Set(offerRows.map((o) => `${o.serviceId}:${o.staffId}`));

  // One free-time timeline per active chair - the same read path as the
  // public slot grid, so the two can never disagree about what "busy" means.
  const timelines = new Map<string, TimeRange[]>();
  for (const staffId of staffIds) {
    const ctx = await computeFreeRanges({
      shopId,
      staffId,
      serviceId: null,
      fromDate: now,
      toDate: dayEnd,
      now,
      ignoreLeadTime: true,
    });
    timelines.set(staffId, ctx ? ctx.free : []);
  }

  const nowMs = now.getTime();
  const consume = (staffId: string, startMs: number, durMs: number): void => {
    const t = timelines.get(staffId) ?? [];
    timelines.set(
      staffId,
      subtractRanges(t, [{ start: startMs, end: startMs + durMs }]),
    );
  };
  const eligibleFor = (e: EntryForEstimate): string[] => {
    if (e.preferredStaffId && staffIds.includes(e.preferredStaffId)) {
      return [e.preferredStaffId];
    }
    const byServices = staffIds.filter((sid) =>
      e.serviceIds.every((svc) => offers.has(`${svc}:${sid}`)),
    );
    return byServices.length > 0 ? byServices : staffIds;
  };

  // Board order: the queue as handed in is already (position, joinedAt, id);
  // re-sort defensively so a caller passing an unsorted set cannot change the
  // simulation's answer.
  const ordered = [...queue].sort(
    (a, b) =>
      a.position - b.position ||
      a.joinedAt.getTime() - b.joinedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Pass 1: entries already WITH a chair, in board order. Their spans come
  // off their own chair's timeline before anyone waiting is seated.
  for (const e of ordered) {
    const durMs = (Math.max(1, e.totalDurationMin) + buffer) * MS_PER_MIN;
    if (e.status === "IN_SERVICE") {
      // Being served now; the real Appointment row already blocks the chair.
      out.set(e.id, {
        projectedStaffId: e.assignedStaffId,
        startsAt: now,
        waitMin: 0,
      });
      continue;
    }
    if (
      (e.status === "ASSIGNED" || e.status === "READY") &&
      e.assignedStaffId
    ) {
      const fit = findFit(timelines.get(e.assignedStaffId) ?? [], nowMs, durMs);
      if (fit === null) {
        out.set(e.id, {
          projectedStaffId: e.assignedStaffId,
          startsAt: null,
          waitMin: null,
        });
      } else {
        consume(e.assignedStaffId, fit, durMs);
        out.set(e.id, {
          projectedStaffId: e.assignedStaffId,
          startsAt: new Date(fit),
          waitMin: Math.max(0, Math.round((fit - nowMs) / MS_PER_MIN)),
        });
      }
    }
  }

  // Pass 2: WAITING entries, in board order, each taking the earliest fit
  // across their eligible chairs. Tie-break (startMs, staffId asc): staffIds
  // is sorted ascending and `<` keeps the first winner, so equal starts fall
  // to the lowest staffId deterministically.
  for (const e of ordered) {
    if (e.status !== "WAITING") continue;
    const durMs = (Math.max(1, e.totalDurationMin) + buffer) * MS_PER_MIN;
    let best: { staffId: string; start: number } | null = null;
    for (const sid of eligibleFor(e)) {
      const fit = findFit(timelines.get(sid) ?? [], nowMs, durMs);
      if (fit !== null && (best === null || fit < best.start)) {
        best = { staffId: sid, start: fit };
      }
    }
    if (best === null) {
      out.set(e.id, { projectedStaffId: null, startsAt: null, waitMin: null });
      continue;
    }
    consume(best.staffId, best.start, durMs);
    out.set(e.id, {
      projectedStaffId: best.staffId,
      startsAt: new Date(best.start),
      waitMin: Math.max(0, Math.round((best.start - nowMs) / MS_PER_MIN)),
    });
  }

  return out;
}
