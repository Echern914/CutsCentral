import { prisma, runWithShop } from "@chairback/db";
import {
  addDays,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@chairback/config";
import {
  effectiveDurationAt,
  hasOpeningWindows,
  openingSpansForWeekday,
  parseServiceHours,
} from "./pricing.js";
import { weekdayWindowsToRanges } from "./blockedTime.js";
import {
  fullDaysForService,
  shopLocalDayWindow,
} from "./serviceDailyLimit.js";

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
  /**
   * How many MORE minutes would still fit at this start, beyond the service's
   * own effective duration (and beyond any `extraDurationMin` the caller asked
   * for - this is always measured from the bare service, so it reads the same
   * whoever asks). Bounded by the end of the free window this slot sits in,
   * which is already "the next booking plus its buffer" or "the end of the
   * barber's hours", whichever comes first.
   *
   * This is what lets the booking page say "you have 25 minutes of room here"
   * and offer only the add-ons that genuinely fit. It is EXACT for add-ons:
   * extra minutes lengthen the appointment's tail but never move the grid (the
   * walk below steps by effDur regardless of extraMin), so
   * `addOn.durationMin <= maxExtraMin` is equivalent to re-running this engine
   * with that add-on and finding the same slot still offered.
   *
   * It is NOT sufficient for offering a different, longer SERVICE: that service
   * steps its own grid and carries its own hours and group caps, so it can be
   * unbookable at this instant even when the raw room is there. Ask the engine
   * for that service instead - see the /upgrades route.
   */
  maxExtraMin: number;
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
        timeOverrides: true,
        hoursWindows: true,
        serviceGroupId: true,
        dailyLimits: true,
      },
    });
    if (!service || service.durationMin <= 0) return null;

    // SERVICE GROUP (Acuity-style bundle). A group carries the two shop-wide
    // caps - maxPerDay (bookings per shop-local day across all member services)
    // and maxConcurrent (overlapping bookings at once across the group).
    //
    // It no longer carries HOURS. A group's hoursWindows used to override the
    // member service's own, which meant a service's hours were edited in one
    // place and displayed in another, and a grouped service's own windows were
    // dead config the engine silently ignored. Hours now live on the service,
    // always - one owner, one place to edit (see the migration that copied each
    // active group's windows down onto its members). ServiceGroup.hoursWindows
    // is deliberately still in the schema but no longer read.
    //
    // Ungrouped services (serviceGroupId null - every existing service, every
    // new shop) skip this entirely and the rest of the engine is byte-for-byte
    // the pre-group behavior.
    const group = service.serviceGroupId
      ? await tx.serviceGroup.findFirst({
          where: { id: service.serviceGroupId, shopId: input.shopId, active: true },
          select: { id: true, maxPerDay: true, maxConcurrent: true },
        })
      : null;

    // Member service ids of the group - the caps count bookings across ALL of
    // them (a group cap is a shared resource cap, not a per-service one). Only
    // needed when a cap is actually set; skip the query otherwise. NOTE: this is
    // deliberately NOT filtered by active - a member service that was later
    // deactivated can still have live future BOOKED/PENDING appointments, and
    // those must keep counting against the shared cap (a deactivated service is
    // no longer bookable, but its existing bookings still consume the resource).
    const groupMemberIds =
      group && (group.maxPerDay !== null || group.maxConcurrent !== null)
        ? (
            await tx.service.findMany({
              where: { serviceGroupId: group.id, shopId: input.shopId },
              select: { id: true },
            })
          ).map((s) => s.id)
        : [];

    // Group-cap appointment set: BOOKED+PENDING (active-hold-aware, SAME
    // predicate as `booked` above) member-service rows across the WHOLE shop
    // (all staff), over a padded window. This is a SEPARATE query from `booked`
    // and is NOT gated by ignoreBooked: the caps are an availability rule (like
    // service-hours), so the write-path check (isSlotBookable, ignoreBooked=true)
    // must still honor them even though it skips the per-staff `booked`
    // subtraction. Excludes the caller's own row on reschedule, mirroring booked.
    const groupCapAppts =
      groupMemberIds.length > 0
        ? await tx.appointment.findMany({
            where: {
              serviceId: { in: groupMemberIds },
              shopId: input.shopId,
              status: { in: ["BOOKED", "PENDING"] },
              AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }] }],
              startsAt: { lt: new Date(rangeEnd) },
              endsAt: { gt: new Date(rangeStart) },
              ...(input.excludeAppointmentId
                ? { id: { not: input.excludeAppointmentId } }
                : {}),
            },
            select: { startsAt: true, endsAt: true },
          })
        : [];

    // PER-SERVICE DAILY CAP. Which shop-local days already hold as many of
    // THIS service as the barber allows on that weekday. One query for the
    // whole window; skipped entirely (no query) when the service has no caps,
    // which is every existing service.
    //
    // Fetched unconditionally rather than behind ignoreBooked, for the same
    // reason the group caps are: a cap is an availability RULE, so the
    // write-path re-check (isSlotBookable, ignoreBooked=true) has to see it
    // too. The authoritative guard is still assertServiceDayHasRoom inside the
    // booking transaction - this is what stops the slot being OFFERED.
    const serviceFullDays = await fullDaysForService(tx, {
      shopId: input.shopId,
      serviceId: input.serviceId,
      dailyLimits: service.dailyLimits,
      timezone: shop.timezone,
      rangeStart: new Date(rangeStart),
      rangeEnd: new Date(rangeEnd),
      excludeAppointmentId: input.excludeAppointmentId,
      now,
    });

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

    // LIVE waitlist holds: a freed slot OFFERED to one customer is theirs
    // until the hold lapses, so the public grid must not show it to anyone
    // else. Same predicate discipline as receptionist holds - OFFERED and
    // unexpired blocks; an expired-but-unswept row frees its time instantly
    // (the worker's EXPIRED flip is hygiene). Skipped by the write-path check
    // like booked rows: the tx guard in bookingWrite.ts is authoritative
    // there, and it is also what lets a claim exclude its OWN hold.
    const waitlistHolds = input.ignoreBooked
      ? []
      : await tx.waitlistOffer.findMany({
          where: {
            staffId: input.staffId,
            shopId: input.shopId,
            status: "OFFERED",
            expiresAt: { gt: now },
            startsAt: { lt: new Date(rangeEnd) },
            endsAt: { gt: new Date(rangeStart) },
          },
          select: { startsAt: true, endsAt: true },
        });

    // Synced EXTERNAL appointments (Acuity/Square Visits) occupy their span
    // too. A shop that switches to native booking often still has FUTURE
    // synced appointments on the books — without this the picker offers those
    // times and double-books the chair. Visits carry no staffId, so an
    // external visit conservatively blocks EVERY barber's slots for its
    // window (exact for single-barber shops; safe for multi-chair). Visits
    // promoted from a NATIVE appointment are excluded — their Appointment row
    // (above) already blocks, and it is the authoritative time on reschedule.
    const externalVisits = input.ignoreBooked
      ? []
      : await tx.visit.findMany({
          where: {
            shopId: input.shopId,
            status: { in: ["SCHEDULED", "RESCHEDULED"] },
            appointment: null,
            scheduledAt: { lt: new Date(rangeEnd) },
            endAt: { gt: new Date(rangeStart) },
          },
          select: { scheduledAt: true, endAt: true },
        });

    // Time the barber blocked off in Acuity. Like external visits it carries no
    // staff, so it blocks every chair for its span - offering a time he blocked
    // in the system he actually manages is the same double-book bug.
    const externalBlocks = await tx.externalBlock.findMany({
      where: {
        shopId: input.shopId,
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      select: { startsAt: true, endsAt: true },
    });

    return {
      service,
      rules,
      recurringBlocks,
      exceptions,
      booked,
      waitlistHolds,
      externalVisits,
      externalBlocks,
      targeted,
      group,
      groupCapAppts,
      serviceFullDays,
    };
  });
  if (!data) return [];
  const {
    service,
    rules,
    recurringBlocks,
    exceptions,
    booked,
    waitlistHolds,
    externalVisits,
    externalBlocks,
    targeted,
    group,
    groupCapAppts,
    serviceFullDays,
  } = data;

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
  //
  // THE SERVICE OWNS ITS HOURS, grouped or not. This used to consult the
  // service's active group first, so a grouped service's own windows were dead
  // config; the group's map is no longer read at all here (see the group query
  // above). Group membership now affects only the shared CAPS below.
  const serviceByWeekday = parseServiceHours(service.hoursWindows);

  // Time-of-day windows the barber explicitly ticked "also open these hours" on.
  // This is the ONE input that WIDENS availability: everything else here can
  // only narrow the staff schedule. It exists because "Sundays I close at 3, but
  // I'll take 9-11pm" had no expressible form - a service-hours window past 3pm
  // intersected to nothing, so the day simply showed no slots.
  //
  // Opened time is UNIONED with the staff span for the day, and deliberately is
  // NOT intersected with the service-hours restriction: an explicit "open this"
  // outranks an implicit "only these hours". It stays subject to everything that
  // subtracts - breaks, block-offs, external blocks, existing bookings, lead
  // time and caps - so it adds candidate time and never overrides a conflict.
  const opensAnyHours = hasOpeningWindows(service.timeOverrides);

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
  // An opening window must be walked even on a weekday the staff has NO rule for
  // (a barber closed Sundays outright), so the walk can no longer be gated on
  // the staff schedule alone.
  if (byWeekday.size > 0 || opensAnyHours) {
    let cursor = addDays(new Date(rangeStart), -1);
    const walkEnd = addDays(new Date(rangeEnd), 1);
    while (cursor.getTime() <= walkEnd.getTime()) {
      const parts = zonedDateParts(cursor, shop.timezone);
      const dayRules = byWeekday.get(parts.weekday);
      const opened = opensAnyHours
        ? openingSpansForWeekday(service.timeOverrides, parts.weekday)
        : [];
      if (dayRules || opened.length > 0) {
        // Service-hours restriction for THIS weekday. `restricted` is true iff
        // the barber set any windows for this weekday; when true, `allowed` is
        // the (possibly empty) list of allowed local windows.
        const restricted = serviceByWeekday.has(parts.weekday);
        const allowed = restricted ? serviceByWeekday.get(parts.weekday)! : null;

        // Spans are collected for the WHOLE day before conversion, so opened
        // time can be unioned in alongside the staff rules. Overlaps are fine:
        // subtractRanges merges `windows` before use, so an opened window that
        // abuts or overlaps the schedule can't offer the same start twice.
        const localSpans: { startMin: number; endMin: number }[] = [];
        for (const dr of dayRules ?? []) {
          if (dr.endMin <= dr.startMin) continue;

          // Intersect the staff rule with the service's allowed windows in
          // shop-local minute space, BEFORE converting to UTC (so DST is still
          // handled per edge by zonedWallTimeToUtc). Unrestricted => the staff
          // rule passes through unchanged (identical to the original behavior);
          // an empty `allowed` yields no spans, so the day is closed.
          if (!restricted) {
            localSpans.push({ startMin: dr.startMin, endMin: dr.endMin });
          } else {
            for (const a of allowed!) {
              const s = Math.max(dr.startMin, a.startMin);
              const e = Math.min(dr.endMin, a.endMin);
              if (e > s) localSpans.push({ startMin: s, endMin: e });
            }
          }
        }
        // Explicitly opened hours join the day AFTER the narrowing above - they
        // are the barber overriding his own schedule, not something to clip by it.
        localSpans.push(...opened);

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
      cursor = addDays(cursor, 1);
    }
  }

  const blocks: TimeRange[] = [];

  // Recurring weekly block-offs: same per-date walk as the windows above, so the
  // block for a given shop-local date is converted with the SAME DST offset as
  // the availability window it carves. Shared with engines/blockedTime.ts (the
  // targeted-slot surfaces) so grid and specials can never disagree about when
  // a standing break falls. Subtracted unconditionally - a break blocks every
  // service, so it is NOT intersected with the per-service hours restriction.
  blocks.push(
    ...weekdayWindowsToRanges(recurringBlocks, rangeStart, rangeEnd, shop.timezone),
  );

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
  // Live waitlist holds: buffered exactly like the appointment each would
  // become, so the surrounding grid stays claim-compatible.
  for (const h of waitlistHolds) {
    blocks.push({
      start: h.startsAt.getTime(),
      end: h.endsAt.getTime() + buffer * MS_PER_MIN,
    });
  }
  // External synced appointments: same buffer treatment as native rows. The
  // query guarantees endAt is set; the fallback keeps a hypothetical bad row
  // from producing a negative-length block.
  for (const v of externalVisits) {
    blocks.push({
      start: v.scheduledAt.getTime(),
      end: (v.endAt ?? v.scheduledAt).getTime() + buffer * MS_PER_MIN,
    });
  }
  // Acuity blocked-off time. No booking buffer: this is the barber saying "I'm
  // not here", not a cut that needs cleanup time after it.
  for (const b of externalBlocks) {
    blocks.push({ start: b.startsAt.getTime(), end: b.endsAt.getTime() });
  }
  for (const t of targeted) {
    blocks.push({
      start: t.startsAt.getTime(),
      end: t.startsAt.getTime() + (t.durationMin + buffer) * MS_PER_MIN,
    });
  }

  // The lower bound every candidate slot must clear: now + lead, and never
  // before the caller's fromDate. The window walk starts a day BEFORE
  // rangeStart (tz-straddle slack), so honoring fromDate here is what keeps a
  // FUTURE-dated query from returning today's leftovers (asking for tomorrow
  // used to return today's remaining slots).
  const lowerBound = Math.max(earliest, rangeStart);

  // free = windows - blocks, clipped only at the TOP. The lower bound is
  // deliberately NOT clipped in: clipping it re-anchored the slot grid to the
  // bound itself, which is an arbitrary instant (now + lead, to the
  // millisecond). A customer loading the page at 10:23:07.123 with the default
  // 2h lead was offered "12:23 PM, 1:23 PM, 2:23 PM" while every FUTURE day
  // showed a clean 9:00 / 10:00 / 11:00 grid off the window start. Keeping the
  // window's own start as the grid origin and filtering candidates below makes
  // today read exactly like every other day.
  const free = clipRanges(
    subtractRanges(windows, blocks),
    Number.NEGATIVE_INFINITY,
    rangeEnd,
  );

  // Slice each free window into SERVICE-duration steps (the grid the picker
  // shows); require the full extended span + buffer to also fit after the slot
  // so add-ons and turnover are honored. The step/span come from the EFFECTIVE
  // duration for each candidate slot's own start instant - the shop-local
  // weekday layer ("Friday cuts are 20 min") AND the time-of-day windows
  // ("after 9pm cuts are 20 min"), so the grid steps by 30 through the evening
  // then by 20 inside the window, resolved per candidate. With no overrides,
  // no windows, and no add-ons this is identical to the original constant
  // step/tail math.
  const slots: Slot[] = [];
  for (const w of free) {
    let t = w.start;
    for (;;) {
      const effDur = effectiveDurationAt(baseDuration, {
        at: new Date(t),
        timezone: shop.timezone,
        weekdayOverrides: service.durationOverrides,
        timeWindows: service.timeOverrides,
      });
      if (effDur <= 0) break; // defensive: a bad override must not spin forever
      const spanMs = (effDur + extraMin) * MS_PER_MIN;
      const tailMs = spanMs + buffer * MS_PER_MIN;
      if (t + tailMs > w.end) break;
      // Below the bound (already past, inside the lead, or before the caller's
      // fromDate) - step over it WITHOUT moving the grid. `>=` matches the
      // write path's own too_soon test (startsAt < earliest), so the engine can
      // never offer a time the booking POST would turn around and reject.
      if (t >= lowerBound) {
        // Room left at this start, measured from the BARE service (not from
        // effDur + extraMin): `w` is a free range, so everything from `t` to
        // `w.end` is open, and the appointment's tail still needs the buffer.
        // Floored to whole minutes - a stray half minute is not a real offer.
        const maxExtraMin = Math.max(
          0,
          Math.floor((w.end - t) / MS_PER_MIN) - buffer - effDur,
        );
        slots.push({
          startsAt: new Date(t),
          endsAt: new Date(t + spanMs),
          maxExtraMin,
        });
      }
      t += effDur * MS_PER_MIN;
    }
  }
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  // PER-SERVICE DAILY CAP: drop every remaining candidate on a day that is
  // already full for this service. Applied here, before the group block, so
  // BOTH exits below return a capped list - a filter placed after the group
  // block's early return would silently not apply to grouped services.
  const dayCapped =
    serviceFullDays.size > 0
      ? slots.filter(
          (s) => !serviceFullDays.has(shopLocalDayWindow(s.startsAt, shop.timezone).key),
        )
      : slots;

  // GROUP CAPS. Only when the service is in an active group AND a cap is set.
  // The counts are computed from groupCapAppts (BOOKED+PENDING member-service
  // rows shop-wide, hold-aware, excluding the reschedule's own row) - a SEPARATE
  // set from the per-staff `booked` subtraction above, which is left untouched
  // (a group cap is a shared-resource limit, not the per-barber overlap guard).
  // Applied even under ignoreBooked (the write-path check): caps are an
  // availability rule like service-hours, so groupCapAppts is fetched
  // unconditionally when a cap exists, not gated by ignoreBooked.
  //
  //   maxConcurrent: drop a candidate if >= maxConcurrent group appointments
  //     already OVERLAP its [startsAt, endsAt) span (half-open, buffer-free -
  //     this is a resource-contention cap, not a turnover constraint).
  //   maxPerDay: bucket existing group appointments by SHOP-LOCAL calendar day
  //     (zonedDateParts, so DST-correct and matching the customer's day), then
  //     drop every remaining candidate whose own shop-local day is already at
  //     or over the cap.
  //
  // RESIDUAL RACE (documented, accepted): these counts are read outside the
  // booking write tx's advisory lock, so a true concurrent burst can let a cap
  // overshoot by 1 (two writers each see count == cap-1 and both commit). That
  // matches how typical booking tools behave for a barber-facing seasonal cap;
  // the per-(staff,startsAt) unique + tx overlap guard still prevent genuine
  // double-books, only the soft group cap can slip by one under contention.
  if (group && (group.maxPerDay !== null || group.maxConcurrent !== null)) {
    // Shop-local day key (YYYY-MM-DD in shop tz) for a given instant.
    const dayKey = (at: Date): string => {
      const p = zonedDateParts(at, shop.timezone);
      return `${p.year}-${p.month0}-${p.day}`;
    };

    // Pre-bucket existing group appointments by shop-local day for maxPerDay.
    const perDayCount = new Map<string, number>();
    if (group.maxPerDay !== null) {
      for (const a of groupCapAppts) {
        const k = dayKey(a.startsAt);
        perDayCount.set(k, (perDayCount.get(k) ?? 0) + 1);
      }
    }

    const kept: Slot[] = [];
    for (const s of dayCapped) {
      // maxPerDay: this candidate's shop-local day already at/over the cap.
      if (group.maxPerDay !== null) {
        const k = dayKey(s.startsAt);
        if ((perDayCount.get(k) ?? 0) >= group.maxPerDay) continue;
      }
      // maxConcurrent: overlapping group appointments at this candidate's span.
      if (group.maxConcurrent !== null) {
        const sStart = s.startsAt.getTime();
        const sEnd = s.endsAt.getTime();
        let overlap = 0;
        for (const a of groupCapAppts) {
          if (a.startsAt.getTime() < sEnd && a.endsAt.getTime() > sStart) {
            overlap++;
          }
        }
        if (overlap >= group.maxConcurrent) continue;
      }
      kept.push(s);
    }
    return kept;
  }

  return dayCapped;
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
