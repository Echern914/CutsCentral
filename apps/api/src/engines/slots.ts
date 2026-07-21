import { prisma, runWithShop } from "@chairback/db";
import {
  addDays,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@chairback/config";
import { effectiveDurationForDate, parseServiceHours } from "./pricing.js";

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

/**
 * Intersection of two range sets: every sub-span covered by BOTH a and b. Used
 * to constrain staff availability windows to a service's allowed hours (a slot
 * is open only where the staff works AND the service is offered). A two-pointer
 * sweep over the merged, sorted sets. Exported for unit tests; the hot path in
 * computeOpenSlots does the equivalent clamp inline in shop-local minute space.
 */
export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const A = mergeRanges(a);
  const B = mergeRanges(b);
  const out: TimeRange[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i]!.start, B[j]!.start);
    const end = Math.min(A[i]!.end, B[j]!.end);
    if (end > start) out.push({ start, end });
    // Advance whichever range ends first - the other may still overlap the next.
    if (A[i]!.end < B[j]!.end) i++;
    else j++;
  }
  return out;
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
 * or there's no open time. All reads run in one shop-scoped (RLS) transaction.
 */
export async function computeOpenSlots(
  input: ComputeSlotsInput,
): Promise<Slot[]> {
  const now = input.now ?? new Date();

  // The shop row is read on the OWNER connection (plain prisma), never inside
  // runWithShop: Shop has RLS ENABLED with no per-shop policy (and no FORCE),
  // so the owner sees it but the SET-ROLE'd app role is default-denied - a
  // tx.shop read inside the scoped transaction silently returns null.
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

  // Bounds: earliest = now + lead; latest = now + maxDays (and never past
  // toDate). Only shop fields are needed, so an out-of-range query exits
  // before touching the tenant tables at all.
  const earliest = now.getTime() + shop.bookingLeadHours * 60 * MS_PER_MIN;
  const maxHorizon = addDays(now, shop.bookingMaxDays).getTime();
  const rangeStart = Math.max(input.fromDate.getTime(), now.getTime());
  const rangeEnd = Math.min(input.toDate.getTime(), maxHorizon);
  if (rangeEnd <= earliest) return [];

  // ALL tenant reads share ONE shop-scoped transaction. This is the hottest
  // public path (every booking-page slot fetch, plus the write-path
  // availability check): the per-read forShop accessors would open up to 6
  // transactions per call - each a pool checkout plus BEGIN / SET ROLE /
  // set_config / COMMIT round trips - which is what caps concurrent booking
  // traffic on the fixed connection pool. Same queries, same order, same
  // early-outs (null -> []), one checkout. The wheres carry shopId explicitly
  // (the app-layer scoping forShop would add) and RLS still applies via
  // runWithShop. The pure interval math below runs OUTSIDE the transaction so
  // the connection is held only for the reads.
  const data = await runWithShop(input.shopId, async (tx) => {
    const service = await tx.service.findFirst({
      where: { id: input.serviceId, shopId: input.shopId, active: true },
      select: {
        id: true,
        durationMin: true,
        durationOverrides: true,
        hoursWindows: true,
      },
    });
    if (!service || service.durationMin <= 0) return null;

    // The staff must exist, be active, and actually offer this service.
    const offers = await tx.serviceStaff.findMany({
      where: {
        staffId: input.staffId,
        serviceId: input.serviceId,
        shopId: input.shopId,
      },
      select: { id: true },
    });
    if (offers.length === 0) return null;
    const staff = await tx.staff.findFirst({
      where: { id: input.staffId, shopId: input.shopId, active: true },
      select: { id: true },
    });
    if (!staff) return null;

    const rules = await tx.availabilityRule.findMany({
      where: { staffId: input.staffId, shopId: input.shopId },
      select: { weekday: true, startMin: true, endMin: true },
    });

    // Recurring weekly block-offs (a standing lunch break etc.). Same per-staff,
    // weekday-keyed shape as `rules`, but SUBTRACTED - built into `blocks` below
    // via the same per-date UTC walk so DST lands identically to the windows.
    const recurringBlocks = await tx.recurringBlock.findMany({
      where: { staffId: input.staffId, shopId: input.shopId },
      select: { weekday: true, startMin: true, endMin: true },
    });

    // Exceptions over the (slightly padded) window range.
    const exceptions = await tx.availabilityException.findMany({
      where: {
        staffId: input.staffId,
        shopId: input.shopId,
        startsAt: { lt: new Date(rangeEnd + 24 * 60 * MS_PER_MIN) },
        endsAt: { gt: new Date(rangeStart - 24 * 60 * MS_PER_MIN) },
      },
      select: { startsAt: true, endsAt: true, isBlock: true },
    });

    // Barber-published targeted slots: while ACTIVE and UNBOOKED they own
    // their span, so the normal grid never offers a slot over them (they're
    // sold separately, at their own price, via the targetedSlots payload).
    // Booked ones are excluded - the claimed Appointment row below blocks
    // instead. Skipped by the write-path check like booked rows (the tx guard
    // in bookingWrite.ts is authoritative there).
    const targeted = input.ignoreBooked
      ? []
      : await tx.targetedSlot.findMany({
          where: {
            staffId: input.staffId,
            shopId: input.shopId,
            active: true,
            bookedAppointmentId: null,
            startsAt: { lt: new Date(rangeEnd) },
          },
          select: { startsAt: true, durationMin: true },
        });

    // Existing BOOKED appointments occupy their span + the turnover buffer.
    // (Skipped by the write-path check - see ignoreBooked.)
    const booked = input.ignoreBooked
      ? []
      : await tx.appointment.findMany({
          where: {
            staffId: input.staffId,
            shopId: input.shopId,
            // PENDING requests hold their slot too (request-before-booking), so
            // the picker must subtract them just like confirmed BOOKED
            // appointments.
            status: { in: ["BOOKED", "PENDING"] },
            // AI-receptionist holds: an ACTIVE hold (holdExpiresAt > now) blocks
            // like any PENDING row; an EXPIRED one releases its slot immediately -
            // the CANCELED flip by the sweep is hygiene, not what frees the time.
            // (Booking a hold clears holdExpiresAt, so BOOKED rows never carry one.)
            AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }] }],
            startsAt: { lt: new Date(rangeEnd) },
            endsAt: { gt: new Date(rangeStart) },
            ...(input.excludeAppointmentId
              ? { id: { not: input.excludeAppointmentId } }
              : {}),
          },
          select: { startsAt: true, endsAt: true },
        });

    return { service, rules, recurringBlocks, exceptions, booked, targeted };
  });
  if (!data) return [];
  const { service, rules, recurringBlocks, exceptions, booked, targeted } = data;

  // The slot GRID steps by the service length (the start times the picker
  // offers); chosen add-ons extend how much room the appointment needs, NOT
  // which start times exist. The customer picks a slot from the service grid
  // FIRST and add-ons in the details step after - re-stepping the grid by the
  // extended total would reject most already-offered starts (e.g. a 30-min
  // service + 15-min add-on would only accept :00/:45 starts).
  //
  // The service length itself can vary by weekday (durationOverrides - "cuts
  // are 30 min Mon-Thu but 20 min Friday"), so the step/span are resolved PER
  // CANDIDATE SLOT from its own start instant's shop-local weekday (see the
  // loop at the bottom). A free window that crosses shop-local midnight simply
  // switches step size mid-window.
  const baseDuration = service.durationMin;
  const extraMin = Math.max(0, input.extraDurationMin ?? 0);
  const buffer = Math.max(0, shop.bookingBufferMin);

  // Optional per-service available-hours restriction (weekday -> allowed local
  // windows). A weekday ABSENT from the map is unrestricted (staff hours as-is);
  // PRESENT restricts the service to those windows that day (an intersection
  // with staff hours); present + empty means the service isn't offered that day.
  // Empty map (every existing service) => nothing is ever restricted.
  const serviceByWeekday = parseServiceHours(service.hoursWindows);

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
        // Service-hours restriction for THIS weekday. `restricted` is true iff
        // the barber set any windows for this weekday; when true, `allowed` is
        // the (possibly empty) list of allowed local windows.
        const restricted = serviceByWeekday.has(parts.weekday);
        const allowed = restricted ? serviceByWeekday.get(parts.weekday)! : null;

        for (const dr of dayRules) {
          if (dr.endMin <= dr.startMin) continue;

          // Intersect the staff rule with the service's allowed windows in
          // shop-local minute space, BEFORE converting to UTC (so DST is still
          // handled per edge by zonedWallTimeToUtc). Unrestricted => the staff
          // rule passes through unchanged (identical to the original behavior);
          // an empty `allowed` yields no spans, so the day is closed.
          const localSpans: { startMin: number; endMin: number }[] = [];
          if (!restricted) {
            localSpans.push({ startMin: dr.startMin, endMin: dr.endMin });
          } else {
            for (const a of allowed!) {
              const s = Math.max(dr.startMin, a.startMin);
              const e = Math.min(dr.endMin, a.endMin);
              if (e > s) localSpans.push({ startMin: s, endMin: e });
            }
          }

          for (const span of localSpans) {
            const start = zonedWallTimeToUtc(
              parts.year,
              parts.month0,
              parts.day,
              span.startMin,
              shop.timezone,
            );
            const end = zonedWallTimeToUtc(
              parts.year,
              parts.month0,
              parts.day,
              span.endMin,
              shop.timezone,
            );
            windows.push({ start: start.getTime(), end: end.getTime() });
          }
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  const blocks: TimeRange[] = [];

  // Recurring weekly block-offs: same per-date walk as the windows above, so the
  // block for a given shop-local date is converted with the SAME DST offset as
  // the availability window it carves. A Mon 12:00-13:30 block lands at the right
  // wall-clock hour year-round (and on the DST-transition day itself, since
  // zonedWallTimeToUtc resolves the offset at the target instant). Subtracted
  // unconditionally - a break blocks every service, so it is NOT intersected with
  // the per-service hours restriction.
  const blocksByWeekday = new Map<number, { startMin: number; endMin: number }[]>();
  for (const rb of recurringBlocks) {
    if (rb.endMin <= rb.startMin) continue; // defensive
    const list = blocksByWeekday.get(rb.weekday) ?? [];
    list.push({ startMin: rb.startMin, endMin: rb.endMin });
    blocksByWeekday.set(rb.weekday, list);
  }
  if (blocksByWeekday.size > 0) {
    let cursor = addDays(new Date(rangeStart), -1);
    const walkEnd = addDays(new Date(rangeEnd), 1);
    while (cursor.getTime() <= walkEnd.getTime()) {
      const parts = zonedDateParts(cursor, shop.timezone);
      const dayBlocks = blocksByWeekday.get(parts.weekday);
      if (dayBlocks) {
        for (const b of dayBlocks) {
          const start = zonedWallTimeToUtc(
            parts.year,
            parts.month0,
            parts.day,
            b.startMin,
            shop.timezone,
          );
          const end = zonedWallTimeToUtc(
            parts.year,
            parts.month0,
            parts.day,
            b.endMin,
            shop.timezone,
          );
          blocks.push({ start: start.getTime(), end: end.getTime() });
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  for (const ex of exceptions) {
    const r = { start: ex.startsAt.getTime(), end: ex.endsAt.getTime() };
    if (ex.isBlock) blocks.push(r);
    else windows.push(r); // one-off open window
  }

  for (const b of booked) {
    blocks.push({
      start: b.startsAt.getTime(),
      end: b.endsAt.getTime() + buffer * MS_PER_MIN,
    });
  }
  for (const t of targeted) {
    blocks.push({
      start: t.startsAt.getTime(),
      end: t.startsAt.getTime() + (t.durationMin + buffer) * MS_PER_MIN,
    });
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
  // so add-ons and turnover are honored. The step/span come from the EFFECTIVE
  // duration for each candidate slot's own start instant (shop-local weekday) -
  // Friday's 20-min override makes Friday windows step and span by 20 while
  // Thursday still steps by 30. With no overrides and no add-ons this is
  // identical to the original constant step/tail math.
  const slots: Slot[] = [];
  for (const w of free) {
    let t = w.start;
    for (;;) {
      const effDur = effectiveDurationForDate(
        baseDuration,
        service.durationOverrides,
        new Date(t),
        shop.timezone,
      );
      if (effDur <= 0) break; // defensive: a bad override must not spin forever
      const spanMs = (effDur + extraMin) * MS_PER_MIN;
      const tailMs = spanMs + buffer * MS_PER_MIN;
      if (t + tailMs > w.end) break;
      slots.push({ startsAt: new Date(t), endsAt: new Date(t + spanMs) });
      t += effDur * MS_PER_MIN;
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
