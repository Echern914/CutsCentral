/**
 * Auto-fill's clock, shared by the cascade (engines/autoFill.ts) and the
 * waitlist stage it hands on to (engines/waitlistOffer.ts), so the two can
 * never disagree about how long a stage is or when holding must stop. Its own
 * module because waitlistOffer.ts cannot import autoFill.ts (autoFill.ts
 * imports it).
 */

/** How long each group - Gold, Silver, each person on the waitlist - has the time to itself. */
export const AUTO_FILL_STAGE_MS = 15 * 60_000;

/** Nothing is held later than this long before the shop's minimum notice. */
export const AUTO_FILL_MARGIN_MS = 30 * 60_000;

/** A waitlist hold shorter than this is not offered: nobody can act on it in time. */
export const AUTO_FILL_MIN_WAITLIST_HOLD_MS = 10 * 60_000;

/**
 * start - minimum notice - margin: the last moment anything is held for
 * anyone, so a claim can never land inside the notice the shop asks of
 * everyone else.
 */
export function autoFillDeadline(startsAt: Date, bookingLeadHours: number): Date {
  return new Date(startsAt.getTime() - bookingLeadHours * 60 * 60_000 - AUTO_FILL_MARGIN_MS);
}
