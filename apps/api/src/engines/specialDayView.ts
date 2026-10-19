import { createHash } from "node:crypto";
import { Prisma, runWithShop } from "@chairback/db";
import { zonedDateKey, zonedDateParts, zonedMinutesOfDay, zonedWallTimeToUtc } from "@chairback/config";
import { openingConflict, type OpeningConflict, type Span } from "@chairback/config/specialDay";
import { occupyingWhere } from "./chairOccupancy.js";
import { lockStaffCalendars } from "./bookingWrite.js";
import { complementSpans, dayBoundsUtc, MAX_SPECIAL_DAY_OPENINGS, SPECIAL_DAY_PATTERN } from "./specialDay.js";

/**
 * THE LIVE VIEW of one special day (Drick, looking at Holiday pricing: "This
 * should show the 'open live view' so I can select specific prices and TIMES
 * available for that day").
 *
 * readDayView draws the date per chair - what is already there (bookings,
 * Acuity time, blocked time) and the special openings - in shop-local
 * MINUTES, which is what the dashboard timeline lays out. saveDay takes the
 * barber's edited set of openings for each chair (filled in one step, tapped
 * off, tapped in, re-priced one by one) and makes it so, under the same rules
 * as publishing a special day (engines/specialDay.ts):
 *
 *   - under the chairs' calendar locks, in ONE transaction;
 *   - against the day he LOOKED AT: the view carries a `basis` (a hash of
 *     everything on it), and a save whose basis no longer matches writes
 *     nothing and answers 409 with the fresh view;
 *   - a requestId makes a retried save a replay, not a second write;
 *   - a BOOKED opening is never removed, moved or re-priced - whatever the
 *     request says, it stays exactly as the client booked it;
 *   - an opening may only go where the shared rule (config/specialDay.ts) says
 *     it fits - the very function the live view uses to draw and fill.
 *
 * NO NEW STORAGE. Each opening is a TargetedSlot, which has always carried its
 * own price - so "specific prices" is just a different price on one row, and
 * the booking page already sells each opening at the price on its row. The
 * rest of the chair's day is closed by special_day blocks over the complement
 * of the openings, rebuilt on every save.
 */

export interface DayViewOpening {
  id: string;
  startMin: number;
  durationMin: number;
  price: number;
  booked: boolean;
}

export interface DayViewItem {
  startMin: number;
  endMin: number;
  label: string;
}

export interface DayViewChair {
  staffId: string;
  /** The special-day rules on this chair that date ([] = not a special day yet). */
  ruleIds: string[];
  /** The chair's normal hours that weekday - what clients get without a special day. */
  hours: { startMin: number; endMin: number }[];
  openings: DayViewOpening[];
  /** This chair's bookings, requests and live holds (not the booked openings - those are in `openings`). */
  bookings: DayViewItem[];
  /** Bookings synced from Acuity/Square: no chair, so in the way of every chair. */
  external: DayViewItem[];
  /** Blocked time of every kind except this day's own special-day blocks. */
  blocks: DayViewItem[];
}

export interface DayView {
  date: string;
  timezone: string;
  bufferMin: number;
  /** Minutes since the shop's midnight when the date is today; null for a later date. */
  nowMin: number | null;
  name: string | null;
  serviceIds: string[];
  chairs: DayViewChair[];
  /** A fingerprint of everything above but nowMin. A save must quote it. */
  basis: string;
}

/** An instant as minutes of `date` in the shop's zone, clamped to [0, 1440]. */
function minuteOf(at: Date, date: string, timezone: string, dayStart: Date, dayEnd: Date): number {
  if (at.getTime() <= dayStart.getTime()) return 0;
  if (at.getTime() >= dayEnd.getTime()) return 1440;
  const key = zonedDateKey(at, timezone);
  if (key < date) return 0;
  if (key > date) return 1440;
  return zonedMinutesOfDay(at, timezone);
}

function ymd0(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** Shop-local minute of `date` -> UTC instant (1440 = the next midnight). */
export function instantOf(date: string, minute: number, timezone: string): Date {
  return zonedWallTimeToUtc(...ymd0(date), minute, timezone);
}

const byStart = <T extends { startMin: number }>(a: T, b: T) => a.startMin - b.startMin;

/**
 * Read the day for these chairs. Read-only; `db` is the save's transaction
 * (holding the locks) or a fresh shop-scoped one for a plain view.
 */
export async function readDayView(
  db: Prisma.TransactionClient,
  input: { shopId: string; timezone: string; bufferMin: number; date: string; staffIds: string[]; now: Date },
): Promise<DayView> {
  const { shopId, timezone, date, staffIds, now } = input;
  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date, timezone);
  const bufferMs = Math.max(0, input.bufferMin) * 60_000;
  const weekday = zonedDateParts(instantOf(date, 12 * 60, timezone), timezone).weekday;
  const toMin = (at: Date) => minuteOf(at, date, timezone, dayStart, dayEnd);

  const [appts, visits, exceptions, recurring, external, hours, marks] = await Promise.all([
    db.appointment.findMany({
      where: {
        shopId,
        staffId: { in: staffIds },
        ...occupyingWhere(now),
        startsAt: { lt: new Date(dayEnd.getTime() + bufferMs) },
        endsAt: { gt: new Date(dayStart.getTime() - bufferMs) },
      },
      select: {
        id: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        holdExpiresAt: true,
        service: { select: { name: true } },
        client: { select: { firstName: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    db.visit.findMany({
      where: {
        shopId,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        appointment: null,
        scheduledAt: { lt: dayEnd },
        endAt: { gt: dayStart },
      },
      select: { id: true, scheduledAt: true, endAt: true, serviceName: true },
      orderBy: { scheduledAt: "asc" },
    }),
    db.availabilityException.findMany({
      where: {
        shopId,
        staffId: { in: staffIds },
        isBlock: true,
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
        // Not this day's own special-day blocks: those are rebuilt by a save.
        OR: [{ pattern: null }, { pattern: { not: SPECIAL_DAY_PATTERN } }],
      },
      select: { id: true, staffId: true, startsAt: true, endsAt: true, reason: true },
      orderBy: { startsAt: "asc" },
    }),
    db.recurringBlock.findMany({
      where: { shopId, staffId: { in: staffIds }, weekday },
      select: { id: true, staffId: true, startMin: true, endMin: true, reason: true },
    }),
    db.externalBlock.findMany({
      where: { shopId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
      orderBy: { startsAt: "asc" },
    }),
    db.availabilityRule.findMany({
      where: { shopId, staffId: { in: staffIds }, weekday },
      select: { staffId: true, startMin: true, endMin: true },
      orderBy: { startMin: "asc" },
    }),
    db.availabilityException.findMany({
      where: {
        shopId,
        staffId: { in: staffIds },
        pattern: SPECIAL_DAY_PATTERN,
        groupId: { not: null },
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
      select: { staffId: true, groupId: true },
    }),
  ]);

  const ruleIdsAll = [...new Set(marks.map((m) => m.groupId!))];
  const rules = ruleIdsAll.length
    ? await db.targetedSlotRule.findMany({
        where: { shopId, id: { in: ruleIdsAll } },
        select: {
          id: true,
          staffId: true,
          label: true,
          createdAt: true,
          services: { select: { serviceId: true } },
          slots: {
            where: { OR: [{ active: true }, { bookedAppointmentId: { not: null } }] },
            select: { id: true, startsAt: true, durationMin: true, price: true, bookedAppointmentId: true },
            orderBy: { startsAt: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const shopWideBlocks: DayViewItem[] = external.map((b) => ({
    startMin: toMin(b.startsAt),
    endMin: toMin(b.endsAt),
    label: b.reason?.trim() ? `Blocked in Acuity - ${b.reason.trim()}` : "Blocked in Acuity",
  }));
  const externalBookings: DayViewItem[] = visits
    .filter((v) => v.endAt !== null)
    .map((v) => ({
      startMin: toMin(v.scheduledAt),
      endMin: toMin(v.endAt!),
      label: v.serviceName?.trim() ? `${v.serviceName.trim()} (Acuity)` : "Booked in Acuity",
    }));

  const chairs: DayViewChair[] = staffIds.map((staffId) => {
    const mine = rules.filter((r) => r.staffId === staffId);
    const openings: DayViewOpening[] = mine
      .flatMap((r) => r.slots)
      .map((s) => ({
        id: s.id,
        startMin: toMin(s.startsAt),
        durationMin: s.durationMin,
        price: Number(s.price),
        booked: s.bookedAppointmentId !== null,
      }))
      .sort(byStart);
    // A booked opening's own appointment is drawn as that opening - unless it
    // was moved off the opening's time, when it is drawn where it really is.
    const shownAsOpening = new Set(
      mine
        .flatMap((r) => r.slots)
        .filter((s) => s.bookedAppointmentId !== null)
        .map((s) => `${s.bookedAppointmentId}|${s.startsAt.getTime()}`),
    );
    const bookings = appts
      .filter((a) => a.staffId === staffId && !shownAsOpening.has(`${a.id}|${a.startsAt.getTime()}`))
      .map((a) => {
        const who = [a.client?.firstName?.trim(), a.service?.name].filter(Boolean).join(" - ");
        const kind =
          a.holdExpiresAt !== null ? "Being booked" : a.status === "PENDING" ? "Request" : "Booked";
        return { startMin: toMin(a.startsAt), endMin: toMin(a.endsAt), label: who ? `${kind}: ${who}` : kind };
      });
    const blocks: DayViewItem[] = [
      ...exceptions
        .filter((e) => e.staffId === staffId)
        .map((e) => ({
          startMin: toMin(e.startsAt),
          endMin: toMin(e.endsAt),
          label: e.reason?.trim() || "Blocked",
        })),
      ...recurring
        .filter((r) => r.staffId === staffId)
        .map((r) => ({ startMin: r.startMin, endMin: r.endMin, label: r.reason?.trim() || "Weekly break" })),
      ...shopWideBlocks,
    ]
      .filter((b) => b.endMin > b.startMin)
      .sort(byStart);
    return {
      staffId,
      ruleIds: mine.map((r) => r.id),
      hours: hours.filter((h) => h.staffId === staffId).map((h) => ({ startMin: h.startMin, endMin: h.endMin })),
      openings,
      bookings: bookings.filter((b) => b.endMin > b.startMin).sort(byStart),
      external: externalBookings,
      blocks,
    };
  });

  const first = rules[0];
  const body = {
    date,
    timezone,
    bufferMin: input.bufferMin,
    name: first?.label ?? null,
    serviceIds: first ? first.services.map((s) => s.serviceId).sort() : [],
    chairs,
  };
  const basis = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  const today = zonedDateKey(now, timezone);
  return { ...body, nowMin: date === today ? zonedMinutesOfDay(now, timezone) : null, basis };
}

/** The same view outside a save, in its own shop-scoped transaction. */
export function loadDayView(input: Parameters<typeof readDayView>[1]): Promise<DayView> {
  return runWithShop(input.shopId, (tx) => readDayView(tx, input));
}

/** What is on a chair, as spans in minutes, for the shared placement rule. */
export function chairDaySpans(chair: DayViewChair) {
  const span = (i: { startMin: number; endMin: number }): Span => ({ start: i.startMin, end: i.endMin });
  return {
    bookings: chair.bookings.map(span),
    external: chair.external.map(span),
    blocks: chair.blocks.map(span),
  };
}

export interface DesiredOpening {
  /** An opening already on the day (kept, or re-priced); absent = a new one. */
  id?: string;
  startMin: number;
  durationMin: number;
  price: number;
}

export type SaveRefusal = OpeningConflict | "unknown_opening" | "booked_opening" | "too_many_openings";

export type SaveDayOutcome =
  | {
      ok: true;
      replay: boolean;
      view: DayView;
      summary: { added: number; removed: number; repriced: number; bookedKept: number };
    }
  | { ok: false; error: "changed"; view: DayView }
  | { ok: false; error: "invalid_opening"; staffId: string; startMin: number; reason: SaveRefusal };

/** The value most openings share (ties: the first seen) - the rule's summary price/length. */
function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/**
 * Save the live view: make each listed chair's special openings exactly the
 * set asked for (booked openings always stay), and rebuild the blocks that
 * close the rest of that chair's day. A chair left with no openings at all
 * goes back to its normal schedule. Chairs not listed are untouched.
 */
export async function saveDay(input: {
  shopId: string;
  timezone: string;
  bufferMin: number;
  date: string;
  /** Every chair the view covered - the basis was computed over these. */
  staffIds: string[];
  chairs: { staffId: string; openings: DesiredOpening[] }[];
  serviceIds: string[];
  name: string | null;
  requestId: string | null;
  basis: string;
  now: Date;
}): Promise<SaveDayOutcome> {
  const { shopId, timezone, date } = input;
  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date, timezone);
  const viewInput = {
    shopId,
    timezone,
    bufferMin: input.bufferMin,
    date,
    staffIds: input.staffIds,
    now: input.now,
  };
  return runWithShop(
    shopId,
    async (tx): Promise<SaveDayOutcome> => {
      await lockStaffCalendars(tx, input.staffIds);

      // A retried save (lost answer, double tap): its blocks are already there.
      if (input.requestId) {
        const already = await tx.availabilityException.count({
          where: {
            shopId,
            staffId: { in: input.staffIds },
            pattern: SPECIAL_DAY_PATTERN,
            requestId: input.requestId,
            startsAt: { lt: dayEnd },
            endsAt: { gt: dayStart },
          },
        });
        if (already > 0) {
          return {
            ok: true,
            replay: true,
            view: await readDayView(tx, viewInput),
            summary: { added: 0, removed: 0, repriced: 0, bookedKept: 0 },
          };
        }
      }

      const view = await readDayView(tx, viewInput);
      if (view.basis !== input.basis) return { ok: false, error: "changed", view };

      const label = input.name?.trim() || "Special day";
      const bufferMin = Math.max(0, input.bufferMin);
      const weekday = zonedDateParts(instantOf(date, 12 * 60, timezone), timezone).weekday;
      const summary = { added: 0, removed: 0, repriced: 0, bookedKept: 0 };

      // Plan EVERY chair before writing anything, so a refusal on the third
      // chair leaves the first two untouched too.
      type Plan = {
        chair: DayViewChair;
        final: (DesiredOpening & { booked: boolean })[];
        create: DesiredOpening[];
        update: (DesiredOpening & { id: string })[];
        remove: string[];
      };
      const plans: Plan[] = [];
      for (const ask of input.chairs) {
        const chair = view.chairs.find((c) => c.staffId === ask.staffId);
        if (!chair) continue;
        const existing = new Map(chair.openings.map((o) => [o.id, o]));
        const booked = chair.openings.filter((o) => o.booked);
        const final: Plan["final"] = booked.map((o) => ({ ...o, booked: true }));
        const create: DesiredOpening[] = [];
        const update: Plan["update"] = [];
        // Indexes into `final` of the openings this save places (new or moved).
        const placed = new Set<number>();
        const keptIds = new Set<string>();
        for (const want of ask.openings) {
          if (want.id) {
            const was = existing.get(want.id);
            if (!was || keptIds.has(was.id)) {
              return { ok: false, error: "invalid_opening", staffId: ask.staffId, startMin: want.startMin, reason: "unknown_opening" };
            }
            keptIds.add(was.id);
            if (was.booked) {
              if (want.startMin !== was.startMin || want.durationMin !== was.durationMin || want.price !== was.price) {
                return { ok: false, error: "invalid_opening", staffId: ask.staffId, startMin: want.startMin, reason: "booked_opening" };
              }
              continue; // already in `final`
            }
            const moved = want.startMin !== was.startMin || want.durationMin !== was.durationMin;
            if (moved) placed.add(final.length);
            final.push({ ...want, id: was.id, booked: false });
            if (moved || want.price !== was.price) update.push({ ...want, id: was.id });
          } else {
            placed.add(final.length);
            final.push({ ...want, booked: false });
            create.push(want);
          }
        }
        if (final.length > MAX_SPECIAL_DAY_OPENINGS) {
          return { ok: false, error: "invalid_opening", staffId: ask.staffId, startMin: 0, reason: "too_many_openings" };
        }
        // Only what is new or moved is judged: an untouched opening was fine
        // when it was placed, and the basis says nothing has changed since.
        const spans = chairDaySpans(chair);
        for (const i of placed) {
          const p = final[i]!;
          const reason = openingConflict({ start: p.startMin, end: p.startMin + p.durationMin }, spans, {
            buffer: bufferMin,
            now: view.nowMin,
            others: final
              .filter((_, j) => j !== i)
              .map((f) => ({ start: f.startMin, end: f.startMin + f.durationMin })),
            dayStart: 0,
            dayEnd: 1440,
          });
          if (reason) return { ok: false, error: "invalid_opening", staffId: ask.staffId, startMin: p.startMin, reason };
        }
        const remove = chair.openings.filter((o) => !o.booked && !keptIds.has(o.id)).map((o) => o.id);
        plans.push({ chair, final, create, update, remove });
      }

      for (const { chair, final, create, update, remove } of plans) {
        const staffId = chair.staffId;
        summary.bookedKept += final.filter((f) => f.booked).length;
        if (remove.length > 0) {
          const gone = await tx.targetedSlot.deleteMany({
            where: { shopId, id: { in: remove }, bookedAppointmentId: null },
          });
          summary.removed += gone.count;
        }
        // Every special-day block on this chair that date goes; the ones the
        // final set needs are written fresh below.
        await tx.availabilityException.deleteMany({
          where: {
            shopId,
            staffId,
            pattern: SPECIAL_DAY_PATTERN,
            startsAt: { lt: dayEnd },
            endsAt: { gt: dayStart },
          },
        });

        if (final.length === 0) {
          // No openings left: this chair works its normal schedule that day.
          if (chair.ruleIds.length > 0) {
            await tx.targetedSlotRule.updateMany({
              where: { shopId, id: { in: chair.ruleIds } },
              data: { active: false },
            });
          }
          continue;
        }

        const price = mostCommon(final.map((f) => f.price));
        const cutMin = mostCommon(final.map((f) => f.durationMin));
        const sorted = [...final].sort(byStart);
        const firstStart = sorted[0]!.startMin;
        const lastEnd = Math.max(...sorted.map((f) => f.startMin + f.durationMin));
        const ruleData = {
          serviceId: input.serviceIds[0]!,
          label,
          durationMin: cutMin,
          price,
          // What the series card reads: one window of openings.
          schedule: {
            [String(weekday)]: [
              { startMin: firstStart, durationMin: lastEnd - firstStart, slotMin: cutMin, price },
            ],
          },
          active: true,
        };
        let ruleId = chair.ruleIds[0];
        if (ruleId) {
          await tx.targetedSlotRule.update({ where: { id: ruleId }, data: ruleData });
          await tx.targetedSlotRuleService.deleteMany({ where: { shopId, ruleId } });
          await tx.targetedSlotRuleService.createMany({
            data: input.serviceIds.map((serviceId) => ({ shopId, ruleId: ruleId!, serviceId })),
          });
          // A day published twice over (never by this code) folds into one rule.
          const extra = chair.ruleIds.slice(1);
          if (extra.length > 0) {
            await tx.targetedSlot.updateMany({ where: { shopId, ruleId: { in: extra } }, data: { ruleId } });
            await tx.targetedSlotRule.updateMany({ where: { shopId, id: { in: extra } }, data: { active: false } });
          }
        } else {
          const rule = await tx.targetedSlotRule.create({
            data: {
              shopId,
              staffId,
              anchor: instantOf(date, firstStart, timezone),
              indefinite: false,
              weeksMaterialized: 1,
              ...ruleData,
              services: { create: input.serviceIds.map((serviceId) => ({ shopId, serviceId })) },
            },
            select: { id: true },
          });
          ruleId = rule.id;
        }

        for (const u of update) {
          await tx.targetedSlot.updateMany({
            where: { shopId, id: u.id, bookedAppointmentId: null },
            data: {
              startsAt: instantOf(date, u.startMin, timezone),
              durationMin: u.durationMin,
              price: u.price,
            },
          });
        }
        summary.repriced += update.length;
        if (create.length > 0) {
          await tx.targetedSlot.createMany({
            data: create.map((c) => ({
              shopId,
              staffId,
              serviceId: input.serviceIds[0]!,
              label,
              startsAt: instantOf(date, c.startMin, timezone),
              durationMin: c.durationMin,
              price: c.price,
              ruleId: ruleId!,
            })),
          });
          summary.added += create.length;
        }
        // The day's name and services on every UNBOOKED opening (a booked one
        // keeps exactly what the client booked).
        const open = await tx.targetedSlot.findMany({
          where: { shopId, ruleId, bookedAppointmentId: null },
          select: { id: true },
        });
        const openIds = open.map((o) => o.id);
        if (openIds.length > 0) {
          await tx.targetedSlot.updateMany({
            where: { shopId, id: { in: openIds } },
            data: { label, serviceId: input.serviceIds[0]! },
          });
          await tx.targetedSlotService.deleteMany({ where: { shopId, slotId: { in: openIds } } });
          await tx.targetedSlotService.createMany({
            data: openIds.flatMap((slotId) => input.serviceIds.map((serviceId) => ({ shopId, slotId, serviceId }))),
            skipDuplicates: true,
          });
        }

        const owned = sorted.map((f) => ({
          start: instantOf(date, f.startMin, timezone).getTime(),
          end: instantOf(date, f.startMin + f.durationMin, timezone).getTime() + bufferMin * 60_000,
        }));
        await tx.availabilityException.createMany({
          data: complementSpans(dayStart, dayEnd, owned).map((b) => ({
            shopId,
            staffId,
            startsAt: b.startsAt,
            endsAt: b.endsAt,
            isBlock: true,
            reason: `${label} - only its special openings are bookable`.slice(0, 200),
            groupId: ruleId!,
            requestId: input.requestId,
            pattern: SPECIAL_DAY_PATTERN,
          })),
        });
      }

      return { ok: true, replay: false, view: await readDayView(tx, viewInput), summary };
    },
    { timeout: 20_000 },
  );
}
