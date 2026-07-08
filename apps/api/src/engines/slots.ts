import { forShop, prisma } from "@chairback/db";
import {
  addDays,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@chairback/config";

/**
 * Open-slot computation for the native booking engine.
 *
 * Availability is stored as LOCAL wall-clock minutes per weekday in the shop's
 * timezone (AvailabilityRule); exceptions and existing appointments are concrete
 * UTC instants. For a date range we:
 *   1. turn each weekly rule into a concrete UTC window per date (DST-correct
 *      via zonedWallTimeToUtc - never a hand-rolled offset),
 *   2. add one-off "open" exceptions and subtract "block" exceptions + existing
 *      BOOKED appointments (padded by the shop's turnover buffer),
 *   3. clip to [now+leadHours, now+maxDays],
 *   4. slice each remaining free window into service-duration steps.
 *
 * The returned list is ADVISORY (the customer's browser may be stale): the
 * create endpoint re-checks availability + a row lock inside the write tx, and a
 * partial unique on (staffId, startsAt) is the final backstop. See
 * routes/booking.public.ts.
 */

export interface TimeRange {
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

const MS_PER_MIN = 60_000;

/** Merge overlapping/adjacent ranges into a sorted, disjoint set. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    const last = out[out.length - 1]!;
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** base ranges with every busy range removed (set difference). */
export function subtractRanges(
  base: TimeRange[],
  busy: TimeRange[],
): TimeRange[] {
  const busies = mergeRanges(busy);
  let work = mergeRanges(base);
  for (const b of busies) {
    const next: TimeRange[] = [];
    for (const w of work) {
      // No overlap: keep whole.
      if (b.end <= w.start || b.start >= w.end) {
        next.push(w);
        continue;
      }
      // Left remainder.
      if (b.start > w.start) next.push({ start: w.start, end: b.start });
      // Right remainder.
      if (b.end < w.end) next.push({ start: b.end, end: w.end });
    }
    work = next;
  }
  return work;
}

/** Clip ranges to [min, max], dropping anything that falls entirely outside. */
function clipRanges(ranges: TimeRange[], min: number, max: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of ranges) {
    const start = Math.max(r.start, min);
    const end = Math.min(r.end, max);
    if (end > start) out.push({ start, end });
  }
  return out;
}

export interface ComputeSlotsInput {
  shopId: string;
  staffId: string;
  serviceId: string;
  fromDate: Date;
  toDate: Date;
  now?: Date;
  /** Ignore this appointment's own time when subtracting busy ranges (reschedule). */
  excludeAppointmentId?: string;
  /**
   * Skip subtracting existing BOOKED appointments. Used by the write-path
   * availability check (isSlotBookable), where the transaction's overlap check +
   * advisory lock are the authoritative conflict guard - so a slot that's merely
   * already taken surfaces as a 409 "slot_taken" there, not a 400 here.
   */
  ignoreBooked?: boolean;
  /**
   * Extra minutes from chosen add-ons, added to the service duration. A longer
   * appointment needs a bigger free window, so the picker only offers slots that
   * can fit service + add-ons (and the write-path check validates the same).
   */
  extraDurationMin?: number;
}

/**
 * Compute bookable slots for one staff member + service over [fromDate, toDate].
 * Returns [] when the staff doesn't offer the service, the service is inactive,
 * or there's no open time. All reads are tenant-scoped through forShop.
 */
export async function computeOpenSlots(
  input: ComputeSlotsInput,
): Promise<Slot[]> {
  const now = input.now ?? new Date();
  const db = forShop(input.shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: input.shopId },
    select: {
      timezone: true,
      bookingLeadHours: true,
      bookingMaxDays: true,
      bookingBufferMin: true,
    },
  });
  if (!shop) return [];

  const service = await db.service.findFirst({
    where: { id: input.serviceId, active: true },
    select: { id: true, durationMin: true },
  });
  if (!service || service.durationMin <= 0) return [];

  // The staff must exist, be active, and actually offer this service.
  const offers = await db.serviceStaff.findMany({
    where: { staffId: input.staffId, serviceId: input.serviceId },
    select: { id: true },
  });
  if (offers.length === 0) return [];
  const staff = await db.staff.findFirst({
    where: { id: input.staffId, active: true },
    select: { id: true },
  });
  if (!staff) return [];

  // The slot GRID steps by the service length (the start times the picker
  // offers); chosen add-ons extend how much room the appointment needs, NOT
  // which start times exist. The customer picks a slot from the service grid
  // FIRST and add-ons in the details step after - re-stepping the grid by the
  // extended total would reject most already-offered starts (e.g. a 30-min
  // service + 15-min add-on would only accept :00/:45 starts).
  const baseDuration = service.durationMin;
  const duration = baseDuration + Math.max(0, input.extraDurationMin ?? 0);
  const buffer = Math.max(0, shop.bookingBufferMin);

  // Bounds: earliest = now + lead; latest = now + maxDays (and never past toDate).
  const earliest = now.getTime() + shop.bookingLeadHours * 60 * MS_PER_MIN;
  const maxHorizon = addDays(now, shop.bookingMaxDays).getTime();
  const rangeStart = Math.max(input.fromDate.getTime(), now.getTime());
  const rangeEnd = Math.min(input.toDate.getTime(), maxHorizon);
  if (rangeEnd <= earliest) return [];

  const rules = await db.availabilityRule.findMany({
    where: { staffId: input.staffId },
    select: { weekday: true, startMin: true, endMin: true },
  });

  // Build the recurring windows by walking each shop-local calendar date across
  // the range (plus a day of slack on each side so a window that straddles
  // midnight in UTC is still captured).
  const windows: TimeRange[] = [];
  const byWeekday = new Map<number, { startMin: number; endMin: number }[]>();
  for (const r of rules) {
    const list = byWeekday.get(r.weekday) ?? [];
    list.push({ startMin: r.startMin, endMin: r.endMin });
    byWeekday.set(r.weekday, list);
  }
  if (byWeekday.size > 0) {
    let cursor = addDays(new Date(rangeStart), -1);
    const walkEnd = addDays(new Date(rangeEnd), 1);
    while (cursor.getTime() <= walkEnd.getTime()) {
      const parts = zonedDateParts(cursor, shop.timezone);
      const dayRules = byWeekday.get(parts.weekday);
      if (dayRules) {
        for (const dr of dayRules) {
          if (dr.endMin <= dr.startMin) continue;
          const start = zonedWallTimeToUtc(
            parts.year,
            parts.month0,
            parts.day,
            dr.startMin,
            shop.timezone,
          );
          const end = zonedWallTimeToUtc(
            parts.year,
            parts.month0,
            parts.day,
            dr.endMin,
            shop.timezone,
          );
          windows.push({ start: start.getTime(), end: end.getTime() });
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  // Exceptions over the (slightly padded) window range.
  const exceptions = await db.availabilityException.findMany({
    where: {
      staffId: input.staffId,
      startsAt: { lt: new Date(rangeEnd + 24 * 60 * MS_PER_MIN) },
      endsAt: { gt: new Date(rangeStart - 24 * 60 * MS_PER_MIN) },
    },
    select: { startsAt: true, endsAt: true, isBlock: true },
  });
  const blocks: TimeRange[] = [];
  for (const ex of exceptions) {
    const r = { start: ex.startsAt.getTime(), end: ex.endsAt.getTime() };
    if (ex.isBlock) blocks.push(r);
    else windows.push(r); // one-off open window
  }

  // Existing BOOKED appointments occupy their span + the turnover buffer.
  // (Skipped by the write-path check - see ignoreBooked.)
  if (!input.ignoreBooked) {
    const booked = await db.appointment.findMany({
      where: {
        staffId: input.staffId,
        // PENDING requests hold their slot too (request-before-booking), so the
        // picker must subtract them just like confirmed BOOKED appointments.
        status: { in: ["BOOKED", "PENDING"] },
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
        ...(input.excludeAppointmentId
          ? { id: { not: input.excludeAppointmentId } }
          : {}),
      },
      select: { startsAt: true, endsAt: true },
    });
    for (const b of booked) {
      blocks.push({
        start: b.startsAt.getTime(),
        end: b.endsAt.getTime() + buffer * MS_PER_MIN,
      });
    }
  }

  // free = windows - blocks, clipped to [max(earliest, rangeStart), rangeEnd].
  // The window walk starts a day BEFORE rangeStart (tz-straddle slack), so the
  // lower clip must honor the caller's fromDate too - clipping only to
  // `earliest` (now + lead) leaked the day-before's windows into a FUTURE-dated
  // query (e.g. asking for tomorrow returned today's remaining slots, anchored
  // at odd now-based minutes). The public page queries from=now (unaffected);
  // the barber's Time picker for a future day was the visible victim.
  const free = clipRanges(
    subtractRanges(windows, blocks),
    Math.max(earliest, rangeStart),
    rangeEnd,
  );

  // Slice each free window into SERVICE-duration steps (the grid the picker
  // shows); require the full extended span + buffer to also fit after the slot
  // so add-ons and turnover are honored. With no add-ons this is identical to
  // the original step/tail math. endsAt reflects the real (extended) end.
  const slots: Slot[] = [];
  const stepMs = baseDuration * MS_PER_MIN;
  const spanMs = duration * MS_PER_MIN;
  const tailMs = (duration + buffer) * MS_PER_MIN;
  for (const w of free) {
    let t = w.start;
    while (t + tailMs <= w.end) {
      slots.push({ startsAt: new Date(t), endsAt: new Date(t + spanMs) });
      t += stepMs;
    }
  }
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/**
 * Authoritative server-side availability check for the WRITE path. The slot list
 * the customer's browser holds is advisory (it can be stale, or bypassed by a
 * crafted POST), so create/reschedule must re-verify the requested time is a
 * real open slot - inside availability rules, not on a blocked exception, within
 * lead/max bounds, and honoring the turnover buffer. This reuses computeOpenSlots
 * so the rule/exception/buffer/bounds math can never drift from what the picker
 * offered: a requested startsAt is bookable iff it exactly matches one offered
 * slot for that (staff, service).
 *
 * `excludeAppointmentId` lets a reschedule ignore the appointment's own current
 * time so it isn't treated as a conflict with itself.
 */
export async function isSlotBookable(input: {
  shopId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  now?: Date;
  excludeAppointmentId?: string;
  /** Extra minutes from chosen add-ons (the appointment must fit service + these). */
  extraDurationMin?: number;
}): Promise<boolean> {
  const target = input.startsAt.getTime();
  // A tight window bracketing the requested start keeps the computation cheap
  // while still letting computeOpenSlots build that day's full set of slots.
  // ignoreBooked: this validates HOURS/EXCEPTIONS/BOUNDS only; whether the slot
  // is already taken is decided authoritatively by the tx overlap check (which
  // returns 409 slot_taken), so a taken slot must still pass availability here.
  const slots = await computeOpenSlots({
    shopId: input.shopId,
    staffId: input.staffId,
    serviceId: input.serviceId,
    fromDate: new Date(target - 24 * 60 * MS_PER_MIN),
    toDate: new Date(target + 24 * 60 * MS_PER_MIN),
    now: input.now,
    excludeAppointmentId: input.excludeAppointmentId,
    extraDurationMin: input.extraDurationMin,
    ignoreBooked: true,
  });
  return slots.some((s) => s.startsAt.getTime() === target);
}
