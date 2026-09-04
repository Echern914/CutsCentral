/**
 * The stable, machine-readable vocabulary for why a booking did not happen.
 *
 * 🔴 WHY THIS EXISTS. A customer typing a malformed email address was told
 * "That time was just taken. Pick another slot." - so they picked another slot,
 * were told the same thing, and left. The booking page classified failures by
 * reaching for whichever branch matched first, and the server had exactly one
 * way to say "something about your request is wrong" (`invalid_input`) and one
 * catch-all that turned ANY unique-constraint violation into `slot_taken`.
 *
 * A code is a CONTRACT, not a message. Nothing in this codebase may decide what
 * happened by matching on human-readable text: copy gets reworded, translated,
 * and shortened for mobile, and every one of those is a silent change to
 * behaviour if a string is load-bearing. The server names the situation; the
 * client decides how to say it.
 *
 * Both apps import from here so a code cannot be added on one side only.
 */

export const BOOKING_ERROR_CODES = [
  /** The email address is not a valid address. FORMAT only - see isLikelyEmail. */
  "INVALID_EMAIL",
  /** The phone number could not be parsed as a real number. */
  "INVALID_PHONE",
  /** Some other field is missing or malformed (name, service, time). */
  "VALIDATION_ERROR",
  /**
   * The requested time is genuinely no longer bookable.
   *
   * 🔴 ONLY the server's atomic booking guard may produce this - the advisory
   * lock plus overlap re-check in engines/bookingWrite.ts, or the appointment
   * table's own (staffId, startsAt) partial unique. It is a statement about the
   * CALENDAR, and anything else that returns it is lying to the customer.
   */
  "SLOT_UNAVAILABLE",
  /** The whole day is full for this service (a per-service daily cap). */
  "DAY_FULL",
  /** Stripe refused the card / the payment method could not be set up. */
  "PAYMENT_METHOD_FAILED",
  /** Too many attempts from this client. */
  "RATE_LIMITED",
  /** Online booking is not available for this shop right now. */
  "BOOKING_UNAVAILABLE",
  /** Anything unexpected. The customer sees a safe generic message. */
  "BOOKING_FAILED",
] as const;

export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[number];

/** Which form field a code points at, when it points at one. */
export type BookingErrorField = "email" | "phone" | "firstName" | "lastName" | "startsAt";

export interface BookingErrorBody {
  /** The legacy string. Kept so existing clients and tests are unaffected. */
  error: string;
  /** The stable code. New code branches on THIS. */
  code: BookingErrorCode;
  /** The field to focus, when the customer can fix it in place. */
  field?: BookingErrorField;
}

/**
 * Is this a plausible email ADDRESS?
 *
 * 🔴 FORMAT ONLY, AND DELIBERATELY PERMISSIVE. This cannot and must not claim
 * the mailbox exists - only that it is shaped like an address. The failure that
 * matters here is the false NEGATIVE: a customer whose real address ChairBack
 * refuses cannot book at all, and will not email to say so.
 *
 * So the rule is the small set of things that are definitely wrong:
 *   - no `@`, or more than one
 *   - nothing before the `@`, or nothing after it
 *   - a domain with no dot, or a final label shorter than two characters
 *   - whitespace, or a leading/trailing/doubled dot
 *
 * Everything else passes, INCLUDING the forms that naive regexes reject and
 * real people use every day: `a+tag@gmail.com`, `first.last@mail.co.uk`,
 * `x@deep.sub.domain.example.com`, apostrophes, and long TLDs.
 *
 * The SAME function runs in the browser and on the server, so the two can never
 * disagree about what is acceptable - a client-side rule stricter than the
 * server's silently blocks bookings the API would have taken, and a looser one
 * bounces the customer off the server for something the form could have caught.
 */
export function isLikelyEmail(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.length === 0) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  if (domain.startsWith("-") || domain.endsWith("-")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (labels.some((l) => l.length === 0)) return false;
  // The TLD must look like a TLD, not like a typo'd port or an IP fragment.
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) return false;
  // Nothing exotic in the domain itself.
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  return true;
}

/** The one message the customer sees under the email field. */
export const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";

/**
 * The one message for a genuinely contested slot.
 *
 * It names what happened AND what the page has already done about it, because
 * the page refreshes availability at the same moment - "pick another" with the
 * dead chip still on screen is what made this read as a broken product.
 */
export const SLOT_CONFLICT_MESSAGE =
  "That time was just booked. We refreshed the available times—please choose another.";
