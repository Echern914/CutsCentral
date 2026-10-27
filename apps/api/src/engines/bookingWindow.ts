/**
 * THE SHOP'S BOOKING RULES, as instants: the last-minute limit ("min notice")
 * and the future limit ("book up to") on the dashboard's Booking rules card
 * (Shop.bookingLeadMinutes, Shop.bookingMaxDays). 🔴 The notice is MINUTES -
 * bookingLeadHours is a legacy column nothing reads any more.
 *
 * Every time a CUSTOMER can book starts inside this window - a regular slot
 * and a special-priced slot (TargetedSlot) alike. Specials used to skip it
 * ("explicit barber inventory"), so a 9 PM special stayed bookable at 8:55 PM
 * over a 2-hour notice and showed months past the book-up-to limit. A special
 * may still sit outside the barber's weekly hours - that is what specials are
 * for - but these two are his rules for when customers book, and they hold.
 *
 * The barber's own bookings from the dashboard are not held to it: the notice
 * exists to protect him, and he is the one booking.
 *
 * One rule for every reader and the booking POST, so a special is never shown
 * that the POST would then refuse.
 */

export interface BookingWindow {
  /** Min notice: nothing a customer books may start before this. */
  earliest: Date;
  /** Book up to: nothing a customer books may start after this. */
  latest: Date;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function bookingWindow(
  shop: { bookingLeadMinutes: number; bookingMaxDays: number },
  now: Date,
): BookingWindow {
  return {
    earliest: new Date(now.getTime() + leadMs(shop)),
    latest: new Date(now.getTime() + shop.bookingMaxDays * DAY_MS),
  };
}

/**
 * The minimum notice in ms. THE one conversion: the slot grid (slots.ts), the
 * booking POST, the manage-link move and the receptionist all go through it,
 * so the grid can never offer a time the write then refuses as too_soon.
 */
export function leadMs(shop: { bookingLeadMinutes: number }): number {
  return shop.bookingLeadMinutes * MINUTE_MS;
}

/** A customer may book a time starting at `startsAt`. Never in the past, whatever the rules say. */
export function insideBookingWindow(startsAt: Date, window: BookingWindow, now: Date): boolean {
  const t = startsAt.getTime();
  return t > now.getTime() && t >= window.earliest.getTime() && t <= window.latest.getTime();
}

/**
 * The same window as a Prisma `startsAt` filter, for reading the specials a
 * customer may book. `from` narrows the lower bound further (the start of the
 * day a day view is showing); it never widens it.
 */
export function bookableStartsAt(
  window: BookingWindow,
  now: Date,
  bounds: { from?: Date; before?: Date } = {},
): { gt: Date; gte: Date; lte: Date; lt?: Date } {
  const gte = bounds.from && bounds.from.getTime() > window.earliest.getTime() ? bounds.from : window.earliest;
  return { gt: now, gte, lte: window.latest, ...(bounds.before ? { lt: bounds.before } : {}) };
}
