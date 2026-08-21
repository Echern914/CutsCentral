/**
 * Reading and writing the two numbers every service form is made of: a price
 * and a length.
 *
 * Both were parsed inline at a dozen call sites, each slightly differently.
 * `Number(price)` accepted "-5" in one form and rejected it in another; a
 * duration typed as "7.5" was silently DROPPED by the override builders
 * (`Number.isInteger` failed, the entry was skipped, the barber's edit
 * vanished with no error). This is one implementation of each, so a value
 * behaves the same wherever it is typed.
 *
 * WHAT IS STORED IS UNCHANGED. Price stays a decimal number of dollars and
 * duration stays a whole number of minutes, exactly as the columns already
 * hold them. This only decides which strings are allowed to become those
 * numbers, and what to say when one isn't.
 *
 * 🔑 THE ANTI-"$$50" RULE. Every field renders its unit as chrome - a "$" set
 * into the left of the box, a "min" set into the right - so a barber who types
 * or pastes "$45" or "30 min" would otherwise commit "$$45". The parsers strip
 * the unit back off. Combined with formatters that take a NUMBER (never a
 * string, so they cannot be applied twice), format -> parse round-trips, which
 * is what serviceFields.test.ts pins.
 */

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: string };
export type ParseResult<T> = ParseOk<T> | ParseErr;

/**
 * Strip the chrome a barber may have typed back into the box: a currency
 * symbol, thousands separators, a "min"/"mins"/"minutes" suffix, stray spaces.
 *
 * Deliberately forgiving on input and strict on output. Pasting "$1,200" from
 * a price list is not a mistake worth an error message; it is just the number
 * with its unit still attached, and the field already shows that unit.
 */
function stripUnits(raw: string): string {
  return raw
    .trim()
    .replace(/^\$/, "")
    .replace(/(?:mins?|minutes)$/i, "")
    .replace(/,/g, "")
    .trim();
}

/**
 * A price in dollars, or null for "not set".
 *
 * null is a real, meaningful value here and not a failure: on the base field it
 * means the service has no listed price, and on an override field it means
 * "this day/window/date uses the base price". Blank must therefore always be
 * allowed to save - the old inline checks that treated it as 0 turned "no
 * price" into "free".
 *
 * Rounded to whole cents because the column is Decimal(10,2): without this,
 * "45.999" showed as typed and came back from the database as 46.00.
 */
export function parsePrice(raw: string): ParseResult<number | null> {
  const cleaned = stripUnits(raw);
  if (cleaned === "") return { ok: true, value: null };

  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Enter a price like 45 or 45.50" };
  }
  if (n < 0) {
    return { ok: false, error: "Price can't be negative" };
  }
  // Two decimal places, because that is what the column holds.
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** The shortest appointment the API will accept. Mirrors the server bound. */
export const MIN_SERVICE_MINUTES = 5;

/**
 * A length in whole minutes, or null for "not set".
 *
 * Fractional input is ROUNDED rather than refused. "7.5" is a barber saying
 * seven and a half minutes, not a typo, and the old builders answered it by
 * throwing the whole entry away without a word. Rounding keeps the edit and
 * the field settles to what was actually saved.
 *
 * `min` defaults to 0 so an ADD-ON ("+0 min") is valid; a service's own length
 * passes MIN_SERVICE_MINUTES, which is the floor the API enforces.
 */
export function parseDuration(
  raw: string,
  opts: { min?: number; max?: number } = {},
): ParseResult<number | null> {
  const { min = 0, max = 24 * 60 } = opts;
  const cleaned = stripUnits(raw);
  if (cleaned === "") return { ok: true, value: null };

  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Enter a length in minutes, like 30" };
  }
  if (n < 0) {
    return { ok: false, error: "Length can't be negative" };
  }
  const whole = Math.round(n);
  if (whole < min) {
    return { ok: false, error: `Length must be at least ${min} minutes` };
  }
  if (whole > max) {
    return { ok: false, error: `Length can't be more than ${max} minutes` };
  }
  return { ok: true, value: whole };
}

/**
 * "$45", "$45.50" - the ONE place a dollar sign is added to a number.
 *
 * Takes a number, never a string, so it cannot be applied to its own output;
 * "$$50" is not a bug that has to be remembered, it is a type error.
 */
export function formatPrice(n: number): string {
  const cents = Math.round(n * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * "30 min" - the ONE place the minutes unit is appended. Same reasoning as
 * formatPrice: a number in, so "30 min min" cannot be constructed.
 *
 * For a span long enough to be worth saying in hours (a blocked-off afternoon,
 * a week of open chair time) use fmtDuration from lib/duration instead. This is
 * for a service length, which is minutes by definition.
 */
export function formatMinutes(n: number): string {
  return `${Math.round(n)} min`;
}
