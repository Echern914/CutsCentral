import type { Prisma } from "@chairback/db";
import { zonedDateParts, zonedMinutesOfDay } from "@chairback/config";

/**
 * "After hours" vs "Special": what the barber sees by the name of a booking
 * that was made INTO one of his targeted slots (Drick: "When they book the
 * targeted slots in the name it should say after hour so i know it").
 *
 * Two facts, kept apart on purpose:
 *
 *  - SPECIAL is history. The booking write stamps `bookedVia = "targeted_slot"`
 *    in the same transaction that claims the slot. The slot link itself is
 *    capacity, not history - a cancel, a declined request or an expired hold
 *    hands it back and the special can then be re-sold or deleted - so the
 *    marker is the only thing that still says "this was a special" afterwards.
 *    A CUSTOMER moving the booking through their manage link clears it: they
 *    can only pick a regular-grid time, at the regular price, so what is left
 *    is an ordinary booking (see POST /manage/:token/reschedule).
 *
 *  - AFTER HOURS is a time fact, and specials are NOT always after hours: the
 *    schedule builder sells morning and afternoon specials, a lunch special,
 *    a quiet-Tuesday rate. So "after hours" is only claimed when the booking
 *    starts outside that barber's regular weekly hours for that day - before
 *    the day's first opening, at or after its last close, or on a day he does
 *    not work at all. Anything else booked into a special reads "Special".
 *
 * The day's hours are its ENVELOPE (first open to last close), not each window:
 * a barber who works 9-12 and 6-9 is not "after hours" at 3 PM, he is between
 * shifts. Read from the CURRENT weekly rules, so a barber who later extends his
 * hours past a special's time sees it relabelled "Special" - the label answers
 * "is this outside my hours", and his hours are whatever he says they are now.
 */

/** The origin marker both special-booking paths stamp. */
export const TARGETED_SLOT_ORIGIN = "targeted_slot";

/** The text that rides by the name, on the calendar and in the barber alert. */
export const SPECIAL_LABEL = {
  afterHours: "After hours",
  premium: "Premium hour",
  special: "Special",
} as const;

export type HoursRule = { weekday: number; startMin: number; endMin: number };

/**
 * Does `startsAt` fall outside the envelope of `rules` (ONE staff member's
 * weekly availability) on its own shop-local weekday?
 */
export function outsideRegularHours(
  startsAt: Date,
  timezone: string,
  rules: readonly HoursRule[],
): boolean {
  const { weekday } = zonedDateParts(startsAt, timezone);
  const day = rules.filter((r) => r.weekday === weekday && r.endMin > r.startMin);
  if (day.length === 0) return true;
  const open = Math.min(...day.map((r) => r.startMin));
  const close = Math.max(...day.map((r) => r.endMin));
  const minute = zonedMinutesOfDay(startsAt, timezone);
  return minute < open || minute >= close;
}

export type SpecialKind = { special: boolean; afterHours: boolean; premium: boolean };

const NOT_SPECIAL: SpecialKind = { special: false, afterHours: false, premium: false };

/**
 * PREMIUM is a price fact: the slot charges MORE than the service's own
 * price. "Special" reads as a deal, so a slot that adds to the price says
 * "Premium hour" instead (Drick and Xavier, 2026-09-29: their late slots all
 * charge above the regular price, and every one was tagged "Special").
 * A slot at or below the service price, or a service with no price to compare
 * to, is left as "Special" - it may be a real deal.
 */
export function isPremiumSlot(
  slotPrice: { toString(): string } | number | null | undefined,
  servicePrice: { toString(): string } | number | null | undefined,
): boolean {
  if (slotPrice == null || servicePrice == null) return false;
  const slot = Number(slotPrice.toString());
  const base = Number(servicePrice.toString());
  return Number.isFinite(slot) && Number.isFinite(base) && slot > base;
}

/**
 * Classify appointment rows in one read: only rows booked into a special cost
 * anything, and they share ONE availabilityRule query across their staff.
 * Rows that are not specials are absent from the map (read them as
 * NOT_SPECIAL via `specialKindOf`).
 */
export async function specialKinds(
  tx: Prisma.TransactionClient,
  shopId: string,
  timezone: string,
  rows: readonly { id: string; staffId: string; startsAt: Date; bookedVia: string | null }[],
): Promise<Map<string, SpecialKind>> {
  const out = new Map<string, SpecialKind>();
  const specials = rows.filter((r) => r.bookedVia === TARGETED_SLOT_ORIGIN);
  if (specials.length === 0) return out;
  const rules = await tx.availabilityRule.findMany({
    where: { shopId, staffId: { in: [...new Set(specials.map((r) => r.staffId))] } },
    select: { staffId: true, weekday: true, startMin: true, endMin: true },
  });
  // Slot price vs the service's own price, for the premium/special wording.
  const specialIds = specials.map((r) => r.id);
  const slots = await tx.targetedSlot.findMany({
    where: { shopId, bookedAppointmentId: { in: specialIds } },
    select: { bookedAppointmentId: true, price: true },
  });
  const appts = await tx.appointment.findMany({
    where: { shopId, id: { in: specialIds } },
    select: { id: true, service: { select: { price: true } } },
  });
  const slotPrice = new Map(slots.map((x) => [x.bookedAppointmentId, x.price]));
  const servicePrice = new Map(appts.map((x) => [x.id, x.service?.price ?? null]));
  for (const r of specials) {
    out.set(r.id, {
      special: true,
      premium: isPremiumSlot(slotPrice.get(r.id), servicePrice.get(r.id)),
      afterHours: outsideRegularHours(
        r.startsAt,
        timezone,
        rules.filter((x) => x.staffId === r.staffId),
      ),
    });
  }
  return out;
}

export function specialKindOf(kinds: Map<string, SpecialKind>, id: string): SpecialKind {
  return kinds.get(id) ?? NOT_SPECIAL;
}

/** The word for a special: after hours first (a time fact), then premium (a price fact). */
export function specialLabelOf(kind: SpecialKind): string {
  if (kind.afterHours) return SPECIAL_LABEL.afterHours;
  return kind.premium ? SPECIAL_LABEL.premium : SPECIAL_LABEL.special;
}

/** " (After hours)" / " (Premium hour)" / " (Special)" / "" - the suffix a barber alert puts by the name. */
export function specialNameSuffix(kind: SpecialKind): string {
  if (!kind.special) return "";
  return ` (${specialLabelOf(kind)})`;
}
