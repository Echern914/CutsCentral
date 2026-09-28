/**
 * A SHOP'S OWN POLICIES, AND THE CHECKLIST A CUSTOMER TICKS BEFORE BOOKING.
 *
 * The owner writes these in their own words ("More than 15 minutes late counts
 * as a no-show"). They are shown on the booking page's last step, and each
 * checklist line must be ticked before Confirm works - so nobody can say they
 * were never told.
 *
 * This file holds the limits and the one normalising rule, because three
 * places need them to agree: the settings form (what it lets the owner type),
 * the settings API (what it stores) and the booking API (what it enforces).
 *
 * Pure: no I/O, no clock, no crypto - it is imported by client components.
 *
 * 🔴 BLANK MEANS OFF. No text and no lines is exactly the shop that existed
 * before this feature: nothing is shown and nothing is enforced.
 */

/** The policy text: a few paragraphs, not a contract. */
export const BOOKING_POLICY_TEXT_MAX = 2000;
/** More than a handful of boxes is a form nobody reads. */
export const BOOKING_CHECKLIST_MAX_LINES = 8;
/** One line has to fit beside a checkbox on a phone. */
export const BOOKING_CHECKLIST_LINE_MAX = 160;

/** What the owner has written, cleaned: trimmed, blanks dropped. */
export interface BookingPolicyContent {
  /** null = no written policy. */
  text: string | null;
  /** [] = no checklist, so nothing to tick and nothing enforced. */
  checklist: string[];
}

/**
 * Clean what the owner typed (or what the database holds) into the shape
 * every surface uses. Blank text becomes null; blank lines are dropped rather
 * than rendered as empty boxes a customer has to tick.
 *
 * It does NOT enforce the limits - the settings API refuses over-long input
 * instead of silently cutting a sentence in half.
 */
export function normalizeBookingPolicy(input: {
  text?: string | null;
  checklist?: readonly string[] | null;
}): BookingPolicyContent {
  const text = (input.text ?? "").trim();
  const checklist = (input.checklist ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { text: text.length > 0 ? text : null, checklist };
}

/** Nothing written at all: the booking page shows and enforces nothing. */
export function bookingPolicyIsBlank(p: BookingPolicyContent): boolean {
  return p.text === null && p.checklist.length === 0;
}
