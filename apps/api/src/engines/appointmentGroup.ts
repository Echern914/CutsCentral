import { Prisma } from "@chairback/db";
import { zonedDateParts, zonedMinutesOfDay } from "@chairback/config";
import {
  effectiveDurationAt,
  effectivePriceAt,
  openingSpansForWeekday,
  parseServiceHours,
} from "./pricing.js";

/**
 * Back-to-back group booking: one to three people, one after the other, with
 * the SAME barber at the SAME shop.
 *
 * EVERYTHING IN HERE IS PURE. No database, no clock, no transaction:
 *
 *  1. `planGroupSequence` - who sits when, what each costs, what the visit
 *     comes to.
 *  2. `groupExtraDurationMin` - how much room to ask the availability grid for.
 *  3. `serviceOfferedDuring` - the one question the combined grid check cannot
 *     answer, for members 2 and 3.
 *
 * 🔴 THERE IS DELIBERATELY NO GROUP-SPECIFIC LOCK OR WRITE HERE. The guard is
 * `lockStaffAndAssertSlotFree` from engines/bookingWrite.ts, called ONCE on the
 * COMBINED interval - the advisory lock is keyed on the staff id, so one call
 * already serialises the whole run, and checking [firstStart, lastEnd] is
 * strictly stronger than checking each member (it also catches anything trying
 * to land BETWEEN them). A second, group-flavoured guard would be a second
 * double-booking rule to keep in step with the first, which is exactly the
 * duplication bookingWrite.ts was extracted to end.
 *
 * Creating the rows likewise stays in the route, with the client upsert,
 * consent, intake and payment intent that surround it: a group booking is the
 * ordinary booking write repeated, not a different one.
 *
 * SCOPE, v1, and every one of these is enforced rather than assumed:
 *   - one shop, ONE barber for the whole group (the barber is on the group row,
 *     so "different barbers in one group" cannot even be expressed);
 *   - at most three attendees;
 *   - consecutive, with NO gap between them;
 *   - different services and durations ARE allowed;
 *   - no partial success, ever.
 */

/** 🔴 Three. The UI offers 1/2/3 and the server refuses anything else. */
export const MAX_GROUP_ATTENDEES = 3;

/** What the caller knows about one attendee before any times are worked out. */
export interface GroupAttendeeInput {
  /** The attendee's own first name - what shows on the barber's calendar. */
  firstName: string;
  serviceId: string;
}

/** The slice of Service the planner needs, resolved by the caller. */
export interface GroupPlanService {
  id: string;
  durationMin: number;
  price: Prisma.Decimal | number | null;
  durationOverrides: unknown;
  priceOverrides: unknown;
  dateOverrides: unknown;
  timeOverrides: unknown;
}

/** One attendee, placed. */
export interface PlannedGroupMember {
  /** 0-based place in the run. 0 sits first. */
  position: number;
  firstName: string;
  serviceId: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  durationMin: number;
  /** null when the service has no price set - same meaning as on a booking. */
  priceCents: number | null;
}

export interface GroupPlan {
  members: PlannedGroupMember[];
  /** The first attendee's start - when the party is expected. */
  startsAt: Date;
  /** The last attendee's end - when the chair frees up. */
  endsAt: Date;
  /** Sum of every member's duration. No gaps, so this is also endsAt-startsAt. */
  totalDurationMin: number;
  /**
   * Sum of every priced member. 🔴 A member with a NULL price contributes
   * nothing AND is reported in `unpricedCount`, because a total that silently
   * treats "price not set" as "free" is how a customer is quoted a number the
   * shop never agreed to.
   */
  totalPriceCents: number;
  unpricedCount: number;
}

export class GroupPlanError extends Error {
  constructor(
    message:
      | "too_few_attendees"
      | "too_many_attendees"
      | "unknown_service"
      | "empty_attendee_name",
  ) {
    super(message);
    this.name = "GroupPlanError";
  }
}

/**
 * Lay the attendees out end to end from `startsAt`.
 *
 * 🔴 EACH DURATION IS RESOLVED AT ITS OWN START, NOT AT THE GROUP'S. Services
 * carry per-weekday and per-time-window duration overrides ("cuts are 30 min
 * Mon-Thu, 20 min Friday"), and `effectiveDurationAt` takes the instant for
 * exactly that reason. The obvious implementation - resolve every duration up
 * front against the group start - is wrong the moment a run crosses a shop-local
 * midnight or a time window boundary, and it is wrong silently: the sequence
 * looks plausible and the last appointment is simply the wrong length.
 *
 * So this folds: resolve at the running cursor, advance, resolve again. Price
 * is resolved at the same instant for the same reason - a member who sits after
 * 9pm pays the 9pm-window price, not the one the first attendee paid.
 *
 * 🔴 NO TURNOVER BUFFER BETWEEN MEMBERS. The shop's buffer exists to space out
 * DIFFERENT parties; these people arrived together and the whole point is that
 * the second sits down as the first gets up. The buffer still guards the
 * outside of the run: lockStaffAndAssertSlotFree pads the COMBINED interval on
 * both sides, so the party is still spaced from whoever comes before and after.
 */
export function planGroupSequence(input: {
  attendees: GroupAttendeeInput[];
  startsAt: Date;
  timezone: string;
  /** Every service the attendees chose, by id. */
  services: Map<string, GroupPlanService & { name: string }>;
}): GroupPlan {
  const { attendees, startsAt, timezone, services } = input;
  if (attendees.length < 1) throw new GroupPlanError("too_few_attendees");
  if (attendees.length > MAX_GROUP_ATTENDEES) {
    throw new GroupPlanError("too_many_attendees");
  }

  const members: PlannedGroupMember[] = [];
  let cursor = startsAt;
  let totalPriceCents = 0;
  let unpricedCount = 0;

  for (const [position, attendee] of attendees.entries()) {
    const name = attendee.firstName.trim();
    if (name.length === 0) throw new GroupPlanError("empty_attendee_name");
    const service = services.get(attendee.serviceId);
    if (!service) throw new GroupPlanError("unknown_service");

    const durationMin = effectiveDurationAt(service.durationMin, {
      at: cursor,
      timezone,
      weekdayOverrides: service.durationOverrides,
      timeWindows: service.timeOverrides,
    });
    const memberEnds = new Date(cursor.getTime() + durationMin * 60_000);

    const basePrice =
      service.price === null ? null : Number(service.price);
    const price = effectivePriceAt(basePrice, {
      at: cursor,
      timezone,
      weekdayOverrides: service.priceOverrides,
      dateOverrides: service.dateOverrides,
      timeWindows: service.timeOverrides,
    });
    // Money in CENTS from here on. A running total in floating-point dollars
    // drifts, and this number is shown to a customer before they confirm.
    const priceCents = price === null ? null : Math.round(price * 100);
    if (priceCents === null) unpricedCount += 1;
    else totalPriceCents += priceCents;

    members.push({
      position,
      firstName: name,
      serviceId: service.id,
      serviceName: service.name,
      startsAt: cursor,
      endsAt: memberEnds,
      durationMin,
      priceCents,
    });
    cursor = memberEnds;
  }

  const first = members[0]!;
  const last = members[members.length - 1]!;
  return {
    members,
    startsAt: first.startsAt,
    endsAt: last.endsAt,
    totalDurationMin: members.reduce((n, m) => n + m.durationMin, 0),
    totalPriceCents,
    unpricedCount,
  };
}

/**
 * The extra minutes beyond the FIRST member's service that the barber must
 * also have free, for `computeOpenSlots`/`isSlotBookable`.
 *
 * 🔴 WHY THE GRID IS STEPPED BY THE FIRST SERVICE AND WIDENED BY THE REST.
 * `extraDurationMin` is the existing mechanism for add-ons and means exactly
 * this: the START TIMES on offer come from the first service's grid, while the
 * ROOM required is the whole run. Re-stepping the grid by the combined total
 * would reject most starts the picker already shows - a 30-minute cut plus a
 * 20-minute kids cut would only accept :00 and :50 starts - and the customer
 * would see a barber's day mysteriously empty out as they added people.
 */
export function groupExtraDurationMin(plan: GroupPlan): number {
  const first = plan.members[0];
  if (!first) return 0;
  return plan.totalDurationMin - first.durationMin;
}

/**
 * Is THIS member's service actually offered across THIS member's own span?
 *
 * 🔴 WHY THE COMBINED AVAILABILITY CHECK IS NOT ENOUGH. The group is validated
 * against the FIRST member's slot grid, widened by the rest of the run
 * (groupExtraDurationMin). That correctly answers "can the barber sit here,
 * uninterrupted, for the whole visit" - and it says nothing at all about
 * whether member 2's service is offered at 2:30.
 *
 * 🔴 AND isSlotBookable CANNOT ANSWER IT EITHER. Member 2's start comes from
 * member 1's length, so it is generally OFF member 2's own grid - a 20-minute
 * kids cut stepping from a 10:00 open offers 2:20 and 2:40, never the 2:30 the
 * group puts it at. Asking isSlotBookable about member 2 would refuse almost
 * every valid group. The question here is narrower and is the only one left:
 * service HOURS.
 *
 * The rules mirror engines/slots.ts exactly, because a group must not be able
 * to book something the ordinary grid would never have offered:
 *
 *   - weekday ABSENT from the map  -> unrestricted, the staff schedule governs;
 *   - weekday PRESENT but EMPTY    -> the service is not offered that day;
 *   - weekday PRESENT with windows -> the span must fit inside ONE of them;
 *   - an explicitly OPENED window  -> passes regardless of the above, because
 *     "also open these hours" is the barber overriding his own schedule and
 *     slots.ts adds that time AFTER the narrowing, not subject to it.
 *
 * A span crossing shop-local midnight is refused: minute-of-day comparison
 * stops meaning anything across the boundary, and a member landing on the next
 * day is a case nobody has asked for.
 */
export function serviceOfferedDuring(input: {
  hoursWindows: unknown;
  timeOverrides: unknown;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}): boolean {
  const { hoursWindows, timeOverrides, startsAt, endsAt, timezone } = input;
  const startMin = zonedMinutesOfDay(startsAt, timezone);
  const endMin = zonedMinutesOfDay(endsAt, timezone);
  // Crossed shop-local midnight (or landed exactly on it): minute-of-day
  // comparisons stop being meaningful, so refuse rather than guess.
  if (endMin <= startMin) return false;

  const { weekday } = zonedDateParts(startsAt, timezone);

  // Explicitly opened hours outrank the restriction below - same order as slots.
  for (const w of openingSpansForWeekday(timeOverrides, weekday)) {
    if (startMin >= w.startMin && endMin <= w.endMin) return true;
  }

  const byWeekday = parseServiceHours(hoursWindows);
  if (!byWeekday.has(weekday)) return true; // unrestricted on this weekday
  for (const w of byWeekday.get(weekday)!) {
    if (startMin >= w.startMin && endMin <= w.endMin) return true;
  }
  return false;
}
