import { prisma, Prisma, runWithShop } from "@chairback/db";
import { zonedDateKey, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { blockedRangesByStaff, spanIsBlocked } from "./blockedTime.js";
import { occupyingWhere } from "./chairOccupancy.js";
import { lockStaffCalendars } from "./bookingWrite.js";
import { MAX_SLOTS_PER_WINDOW } from "./targetedSlotRules.js";

/**
 * A SPECIAL DAY - "on Thanksgiving every cut is 20 minutes and $65, 9 to 5,
 * and nothing else" (Drick). Built from two things that already exist, so no
 * slot-engine layer knows about it:
 *
 *   1. TARGETED SLOTS - one row per opening, grouped under ONE finite
 *      TargetedSlotRule per chair (the rule exists to group and remove the
 *      batch, exactly like a finite series). The booking page already sells
 *      them with the Special chip at their own price, and the booking claim
 *      already gives each a capacity of one.
 *   2. AVAILABILITY-EXCEPTION BLOCKS over the rest of that chair's day - the
 *      COMPLEMENT of the openings, never a whole-day block. That is the whole
 *      trick: a whole-day block would also hide the special openings
 *      (filterBlockedTargeted drops any special a block touches, and the
 *      booking claim refuses one), so the blocks cover exactly the minutes the
 *      openings do not. Inside the window the unbooked openings already keep
 *      the normal grid off their span (slots.ts), so the normal schedule is
 *      closed all day while every opening stays bookable - with no change to
 *      the block, grid or claim rules.
 *
 * Each opening OWNS [start, start + cut + buffer): the shop's turnover buffer
 * is what the booking guard pads every booking with, so openings are spaced by
 * cut + buffer and the blocks start where that tail ends. Spaced any tighter,
 * the second of two back-to-back openings would be refused the moment the
 * first was booked.
 *
 * The rows are tied together by the block's groupId = the rule's id and
 * pattern = SPECIAL_DAY_PATTERN, which is how a rule is recognised as a
 * special day (listing, removal, and the series editor refusing it).
 *
 * 🔴 NEVER OVER A BOOKING. An opening that would overlap something already on
 * that chair - a booking or request, a live hold, an Acuity/Square booking,
 * blocked time - is left out and reported, never created on top of it. Bookings
 * that day are never moved or cancelled; the blocks simply sit around them.
 */

export const SPECIAL_DAY_PATTERN = "special_day";
/** Most chairs one publish may cover. */
export const MAX_SPECIAL_DAY_CHAIRS = 10;
/** Most openings one chair's special day may hold - the window cap series use. */
export const MAX_SPECIAL_DAY_OPENINGS = MAX_SLOTS_PER_WINDOW;

export interface SpecialDaySpec {
  /** Shop-local YYYY-MM-DD. */
  date: string;
  staffIds: string[];
  /** Shop-local minutes from midnight; end exclusive. */
  startMin: number;
  endMin: number;
  cutMin: number;
}

export type SkipReason = "booking" | "blocked" | "past";

export interface ChairPlan {
  staffId: string;
  openings: { startsAt: Date; endsAt: Date }[];
  skipped: { startsAt: Date; reason: SkipReason }[];
  /** Everything already booked on this chair that day (they stay booked). */
  bookings: { startsAt: Date; endsAt: Date }[];
}

/**
 * The opening START minutes a window holds: every cut + buffer from the start
 * while the whole owned span (cut + buffer) still fits before the end.
 */
export function openingStartMinutes(input: {
  startMin: number;
  endMin: number;
  cutMin: number;
  bufferMin: number;
}): number[] {
  const step = input.cutMin + Math.max(0, input.bufferMin);
  const out: number[] = [];
  if (input.cutMin <= 0) return out;
  for (let m = input.startMin; m + step <= input.endMin; m += step) out.push(m);
  return out;
}

/** The shop-local day as UTC instants [start, end). DST-correct. */
export function dayBoundsUtc(date: string, timezone: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return {
    start: zonedWallTimeToUtc(y, m - 1, d, 0, timezone),
    end: zonedWallTimeToUtc(y, m - 1, d + 1, 0, timezone),
  };
}

/**
 * The parts of [dayStart, dayEnd) that NO opening owns - what gets blocked.
 * `owned` need not be sorted; overlapping/touching spans merge.
 */
export function complementSpans(
  dayStart: Date,
  dayEnd: Date,
  owned: { start: number; end: number }[],
): { startsAt: Date; endsAt: Date }[] {
  const sorted = [...owned].sort((a, b) => a.start - b.start);
  const out: { startsAt: Date; endsAt: Date }[] = [];
  let cursor = dayStart.getTime();
  for (const o of sorted) {
    if (o.start > cursor) out.push({ startsAt: new Date(cursor), endsAt: new Date(o.start) });
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < dayEnd.getTime()) out.push({ startsAt: new Date(cursor), endsAt: dayEnd });
  return out;
}

/**
 * Plan every chair's openings for the day, leaving out each one that would
 * overlap anything already on that chair. Read-only. `tx` is the publish
 * transaction (holding the chairs' booking locks) or the plain client for a
 * preview; blocked time is read through the shared engine either way.
 */
export async function planSpecialDay(
  db: Prisma.TransactionClient | typeof prisma,
  input: {
    shopId: string;
    timezone: string;
    bufferMin: number;
    spec: SpecialDaySpec;
    now: Date;
  },
): Promise<ChairPlan[]> {
  const { shopId, timezone, spec, now } = input;
  const bufferMs = Math.max(0, input.bufferMin) * 60_000;
  const cutMs = spec.cutMin * 60_000;
  const { start: dayStart, end: dayEnd } = dayBoundsUtc(spec.date, timezone);
  const [y, m, d] = spec.date.split("-").map(Number) as [number, number, number];
  const starts = openingStartMinutes({ ...spec, bufferMin: input.bufferMin }).map((min) =>
    zonedWallTimeToUtc(y, m - 1, d, min, timezone),
  );

  const [blocked, appts, visits] = await Promise.all([
    blockedRangesByStaff({
      shopId,
      staffIds: spec.staffIds,
      fromMs: dayStart.getTime(),
      toMs: dayEnd.getTime(),
      timezone,
    }),
    // Every booking, request and live hold on these chairs that day - the
    // same occupancy rule the grid, the specials filter and the write guard
    // use (engines/chairOccupancy.ts). Padded by the buffer on both sides.
    db.appointment.findMany({
      where: {
        shopId,
        staffId: { in: spec.staffIds },
        ...occupyingWhere(now),
        startsAt: { lt: new Date(dayEnd.getTime() + bufferMs) },
        endsAt: { gt: new Date(dayStart.getTime() - bufferMs) },
      },
      select: { staffId: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: "asc" },
    }),
    // A booking synced from Acuity/Square carries no chair, so it is in the way
    // of every chair - the stance filterBlockedTargeted and the guard take.
    db.visit.findMany({
      where: {
        shopId,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        appointment: null,
        scheduledAt: { lt: dayEnd },
        endAt: { gt: dayStart },
      },
      select: { scheduledAt: true, endAt: true },
    }),
  ]);

  return spec.staffIds.map((staffId) => {
    const mine = appts.filter((a) => a.staffId === staffId);
    const plan: ChairPlan = {
      staffId,
      openings: [],
      skipped: [],
      bookings: mine.map((a) => ({ startsAt: a.startsAt, endsAt: a.endsAt })),
    };
    for (const startsAt of starts) {
      const s = startsAt.getTime();
      const e = s + cutMs;
      if (s <= now.getTime()) {
        plan.skipped.push({ startsAt, reason: "past" });
        continue;
      }
      const hitsBooking =
        mine.some((a) => a.startsAt.getTime() < e + bufferMs && a.endsAt.getTime() > s - bufferMs) ||
        visits.some((v) => v.endAt !== null && v.scheduledAt.getTime() < e && v.endAt.getTime() > s);
      if (hitsBooking) {
        plan.skipped.push({ startsAt, reason: "booking" });
        continue;
      }
      // serviceId null: a block scoped to ANY service counts - the opening may
      // be booked as any of its services, so the safe reading is "in the way".
      if (spanIsBlocked(blocked.get(staffId), s, e + bufferMs, null)) {
        plan.skipped.push({ startsAt, reason: "blocked" });
        continue;
      }
      plan.openings.push({ startsAt, endsAt: new Date(e) });
    }
    return plan;
  });
}

export type PublishOutcome =
  | { ok: true; replay: boolean; created: { staffId: string; ruleId: string; openings: number }[]; plans: ChairPlan[] }
  | { ok: false; error: "already_exists"; staffIds: string[] }
  | { ok: false; error: "changed"; plans: ChairPlan[] }
  | { ok: false; error: "no_openings"; plans: ChairPlan[] };

/**
 * Publish: every chair's rule, openings and blocks in ONE transaction, under
 * the chairs' booking locks - so a booking racing the publish either lands
 * first (and its opening is left out) or waits and meets the new rows.
 *
 * Double submit: the same requestId replays the first answer; any other
 * publish onto a chair that already has a special day that date is refused.
 * `expectOpenings` (what the preview showed) must still be true, or nothing
 * is written and the fresh plan comes back - the barber never gets a day
 * different from the one he looked at.
 */
export async function publishSpecialDay(input: {
  shopId: string;
  timezone: string;
  bufferMin: number;
  spec: SpecialDaySpec;
  serviceIds: string[];
  price: number;
  name: string | null;
  requestId: string | null;
  expectOpenings: number | null;
  now: Date;
}): Promise<PublishOutcome> {
  const { shopId, spec } = input;
  const { start: dayStart, end: dayEnd } = dayBoundsUtc(spec.date, input.timezone);
  return runWithShop(
    shopId,
    async (tx) => {
      await lockStaffCalendars(tx, spec.staffIds);

      const existing = await tx.availabilityException.findMany({
        where: {
          shopId,
          staffId: { in: spec.staffIds },
          pattern: SPECIAL_DAY_PATTERN,
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
        select: { staffId: true, requestId: true, groupId: true },
      });
      if (existing.length > 0) {
        const sameRequest =
          input.requestId !== null && existing.every((e) => e.requestId === input.requestId);
        if (!sameRequest) {
          return {
            ok: false,
            error: "already_exists",
            staffIds: [...new Set(existing.map((e) => e.staffId))],
          } as const;
        }
        const ruleIds = [...new Set(existing.map((e) => e.groupId).filter((g): g is string => !!g))];
        const counts = await tx.targetedSlot.groupBy({
          by: ["ruleId", "staffId"],
          where: { shopId, ruleId: { in: ruleIds } },
          _count: { _all: true },
        });
        return {
          ok: true,
          replay: true,
          created: counts.map((c) => ({ staffId: c.staffId, ruleId: c.ruleId!, openings: c._count._all })),
          plans: [],
        } as const;
      }

      const plans = await planSpecialDay(tx, {
        shopId,
        timezone: input.timezone,
        bufferMin: input.bufferMin,
        spec,
        now: input.now,
      });
      const total = plans.reduce((n, p) => n + p.openings.length, 0);
      if (input.expectOpenings !== null && total !== input.expectOpenings) {
        return { ok: false, error: "changed", plans } as const;
      }
      if (total === 0) return { ok: false, error: "no_openings", plans } as const;

      const label = input.name?.trim() || "Special day";
      const weekday = zonedDateParts(
        zonedWallTimeToUtc(...ymd(spec.date), 12 * 60, input.timezone),
        input.timezone,
      ).weekday;
      const bufferMs = Math.max(0, input.bufferMin) * 60_000;
      const created: { staffId: string; ruleId: string; openings: number }[] = [];
      for (const plan of plans) {
        const rule = await tx.targetedSlotRule.create({
          data: {
            shopId,
            staffId: plan.staffId,
            serviceId: input.serviceIds[0]!,
            label,
            anchor: plan.openings[0]?.startsAt ?? zonedWallTimeToUtc(...ymd(spec.date), spec.startMin, input.timezone),
            durationMin: spec.cutMin,
            price: input.price,
            // What the series card reads: one window of cut-length openings.
            schedule: {
              [String(weekday)]: [
                {
                  startMin: spec.startMin,
                  durationMin: spec.endMin - spec.startMin,
                  slotMin: spec.cutMin,
                  price: input.price,
                },
              ],
            },
            indefinite: false,
            weeksMaterialized: 1,
            services: { create: input.serviceIds.map((serviceId) => ({ shopId, serviceId })) },
          },
          select: { id: true },
        });
        if (plan.openings.length > 0) {
          const slots = await tx.targetedSlot.createManyAndReturn({
            data: plan.openings.map((o) => ({
              shopId,
              staffId: plan.staffId,
              serviceId: input.serviceIds[0]!,
              label,
              startsAt: o.startsAt,
              durationMin: spec.cutMin,
              price: input.price,
              ruleId: rule.id,
            })),
            select: { id: true },
          });
          await tx.targetedSlotService.createMany({
            data: slots.flatMap((s) =>
              input.serviceIds.map((serviceId) => ({ shopId, slotId: s.id, serviceId })),
            ),
            skipDuplicates: true,
          });
        }
        const blocks = complementSpans(
          dayStart,
          dayEnd,
          plan.openings.map((o) => ({ start: o.startsAt.getTime(), end: o.endsAt.getTime() + bufferMs })),
        );
        await tx.availabilityException.createMany({
          data: blocks.map((b) => ({
            shopId,
            staffId: plan.staffId,
            startsAt: b.startsAt,
            endsAt: b.endsAt,
            isBlock: true,
            reason: `${label} - only its special openings are bookable`.slice(0, 200),
            groupId: rule.id,
            requestId: input.requestId,
            pattern: SPECIAL_DAY_PATTERN,
          })),
        });
        created.push({ staffId: plan.staffId, ruleId: rule.id, openings: plan.openings.length });
      }
      return { ok: true, replay: false, created, plans } as const;
    },
    // A ten-chair day is a few hundred rows; the default 5s is tight for that
    // on a cold pool.
    { timeout: 20_000 },
  );
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m - 1, d];
}

export interface SpecialDayRow {
  ruleId: string;
  staffId: string;
  date: string;
  name: string | null;
  price: number;
  cutMin: number;
  firstStart: string | null;
  lastEnd: string | null;
  openings: number;
  booked: number;
}

/** The special days still ahead (today included), soonest first. */
export async function listSpecialDays(shopId: string, timezone: string, now: Date): Promise<SpecialDayRow[]> {
  return runWithShop(shopId, async (tx) => {
    const marks = await tx.availabilityException.findMany({
      where: { shopId, pattern: SPECIAL_DAY_PATTERN, endsAt: { gt: now }, groupId: { not: null } },
      select: { groupId: true, startsAt: true, endsAt: true },
    });
    const ruleIds = [...new Set(marks.map((m) => m.groupId!))];
    if (ruleIds.length === 0) return [];
    const rules = await tx.targetedSlotRule.findMany({
      where: { shopId, id: { in: ruleIds }, active: true },
      select: {
        id: true,
        staffId: true,
        label: true,
        price: true,
        durationMin: true,
        slots: {
          select: { startsAt: true, durationMin: true, bookedAppointmentId: true },
          orderBy: { startsAt: "asc" },
        },
      },
    });
    const rows = rules.map((r) => {
      const first = r.slots[0];
      const last = r.slots[r.slots.length - 1];
      // The day itself: the last block always runs to that day's midnight
      // (the window ends by 23:59), so a millisecond before it is that day -
      // which also dates a chair whose every opening was left out.
      const lastBlockEnd = Math.max(
        ...marks.filter((m) => m.groupId === r.id).map((m) => m.endsAt.getTime()),
      );
      return {
        ruleId: r.id,
        staffId: r.staffId,
        date: zonedDateKey(new Date(lastBlockEnd - 1), timezone),
        name: r.label,
        price: Number(r.price),
        cutMin: r.durationMin,
        firstStart: first ? first.startsAt.toISOString() : null,
        lastEnd: last ? new Date(last.startsAt.getTime() + last.durationMin * 60_000).toISOString() : null,
        openings: r.slots.length,
        booked: r.slots.filter((s) => s.bookedAppointmentId !== null).length,
      };
    });
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.staffId.localeCompare(b.staffId));
  });
}

/**
 * Remove special days: the rule off, its UNBOOKED openings gone, its blocks
 * gone - in one transaction. Booked openings stay exactly as they are (the
 * client still has that appointment) and are counted back so the barber is
 * told. Only rules that ARE special days are touched.
 */
export async function removeSpecialDays(
  shopId: string,
  ruleIds: string[],
): Promise<{ removed: number; openingsRemoved: number; bookedKept: number }> {
  return runWithShop(shopId, async (tx) => {
    const marks = await tx.availabilityException.findMany({
      where: { shopId, pattern: SPECIAL_DAY_PATTERN, groupId: { in: ruleIds } },
      select: { groupId: true },
    });
    const ids = [...new Set(marks.map((m) => m.groupId!))];
    if (ids.length === 0) return { removed: 0, openingsRemoved: 0, bookedKept: 0 };
    await tx.targetedSlotRule.updateMany({ where: { shopId, id: { in: ids } }, data: { active: false } });
    const gone = await tx.targetedSlot.deleteMany({
      where: { shopId, ruleId: { in: ids }, bookedAppointmentId: null },
    });
    const bookedKept = await tx.targetedSlot.count({
      where: { shopId, ruleId: { in: ids }, bookedAppointmentId: { not: null } },
    });
    await tx.availabilityException.deleteMany({
      where: { shopId, pattern: SPECIAL_DAY_PATTERN, groupId: { in: ids } },
    });
    return { removed: ids.length, openingsRemoved: gone.count, bookedKept };
  });
}

/** Which of these rules are special days (the series editor refuses those). */
export async function specialDayRuleIds(
  db: Prisma.TransactionClient | typeof prisma,
  shopId: string,
  ruleIds: string[],
): Promise<Set<string>> {
  if (ruleIds.length === 0) return new Set();
  const marks = await db.availabilityException.findMany({
    where: { shopId, pattern: SPECIAL_DAY_PATTERN, groupId: { in: ruleIds } },
    select: { groupId: true },
    distinct: ["groupId"],
  });
  return new Set(marks.map((m) => m.groupId!));
}
