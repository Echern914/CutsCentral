import { zonedDateParts } from "@chairback/config";

/**
 * Per-weekday service pricing. A service has a base `price`; `priceOverrides` is
 * a map of shop-local weekday (0=Sun..6=Sat, string keys) to the price charged
 * that day. Only days that differ from the base need an entry. The customer is
 * always shown the effective price for the date they're booking, so a Sunday
 * surcharge is never a surprise, and it's snapshotted onto priceAtBooking.
 */

/** Parse the JSON override blob defensively into a clean weekday->number map. */
export function parsePriceOverrides(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const day = Number(k);
      const price = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(day) && day >= 0 && day <= 6 && Number.isFinite(price) && price >= 0) {
        out[day] = price;
      }
    }
  }
  return out;
}

/**
 * The price for `service` on the calendar date of `at` (interpreted in the
 * shop's timezone, so the weekday matches what the customer sees). Returns the
 * weekday override when present, else the base price, else null (no price set).
 */
export function effectivePriceForDate(
  basePrice: number | null,
  overridesRaw: unknown,
  at: Date,
  timezone: string,
): number | null {
  const { weekday } = zonedDateParts(at, timezone);
  const overrides = parsePriceOverrides(overridesRaw);
  if (Object.prototype.hasOwnProperty.call(overrides, weekday)) {
    return overrides[weekday]!;
  }
  return basePrice;
}

/**
 * Per-weekday DURATION overrides - the exact same shape and semantics as the
 * price overrides above ({"5": 20} = Friday takes 20 minutes), so the two
 * "vary by day" knobs stay one idiom. The effective duration drives the slot
 * GRID (a Friday 20-min cut consumes a 20-min block, and slots step by 20)
 * and the appointment's endsAt, which IS the duration snapshot at booking.
 */

/** Parse the JSON override blob defensively into a clean weekday->minutes map. */
export function parseDurationOverrides(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const day = Number(k);
      const minutes = typeof v === "number" ? v : Number(v);
      if (
        Number.isInteger(day) &&
        day >= 0 &&
        day <= 6 &&
        Number.isInteger(minutes) &&
        minutes >= 5
      ) {
        out[day] = minutes;
      }
    }
  }
  return out;
}

/**
 * Per-service AVAILABLE-HOURS restriction - the third "vary by day" knob, but a
 * map of shop-local weekday to an ARRAY of {startMin,endMin} windows (minutes
 * from midnight, endMin exclusive) rather than a single number. It shapes the
 * slot grid: a slot is open only where the staff is available AND the service is
 * allowed (an INTERSECTION - it never widens staff hours). See slots.ts.
 *
 * The return is a Map, not a plain object, so callers can distinguish a weekday
 * that is ABSENT (unrestricted - use staff hours as-is) from one PRESENT with an
 * empty array (closed that weekday) via `.has(weekday)`. A plain-object record
 * would collapse those two very different cases.
 */
export function parseServiceHours(
  raw: unknown,
): Map<number, { startMin: number; endMin: number }[]> {
  const out = new Map<number, { startMin: number; endMin: number }[]>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const day = Number(k);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      if (!Array.isArray(v)) continue; // malformed weekday -> treat as absent
      const windows: { startMin: number; endMin: number }[] = [];
      for (const w of v) {
        if (!w || typeof w !== "object") continue;
        const s = Number((w as { s?: unknown }).s);
        const e = Number((w as { e?: unknown }).e);
        // Bounds mirror serviceWindowSchema (booking.dashboard.ts) exactly so the
        // write-time validator and this read-time defense accept the same set: s
        // is a start minute [0,1439], e is exclusive [1,1440], end after start.
        if (
          Number.isInteger(s) &&
          Number.isInteger(e) &&
          s >= 0 &&
          s <= 1439 &&
          e >= 1 &&
          e <= 1440 &&
          e > s
        ) {
          windows.push({ startMin: s, endMin: e });
        }
      }
      // Present key is preserved even when it parses to zero windows: an
      // explicit empty [] means "closed that weekday", distinct from absent.
      out.set(day, windows);
    }
  }
  return out;
}

/**
 * The duration (minutes) for a service on the calendar date of `at`, resolved
 * by the SHOP-timezone weekday - a 9pm Thursday booking in the shop's timezone
 * uses Thursday's duration even when that instant is already Friday in UTC.
 */
export function effectiveDurationForDate(
  baseDurationMin: number,
  overridesRaw: unknown,
  at: Date,
  timezone: string,
): number {
  const { weekday } = zonedDateParts(at, timezone);
  const overrides = parseDurationOverrides(overridesRaw);
  if (Object.prototype.hasOwnProperty.call(overrides, weekday)) {
    return overrides[weekday]!;
  }
  return baseDurationMin;
}

/**
 * Distinct durations a service can have across the week, for menu display
 * ("30 min" or "20-30 min"). Mirrors priceRangeForService.
 */
export function durationRangeForService(
  baseDurationMin: number,
  overridesRaw: unknown,
): { min: number; max: number } {
  const overrides = parseDurationOverrides(overridesRaw);
  const values: number[] = [baseDurationMin];
  const allSevenOverridden = [0, 1, 2, 3, 4, 5, 6].every((d) =>
    Object.prototype.hasOwnProperty.call(overrides, d),
  );
  if (allSevenOverridden) values.pop();
  values.push(...Object.values(overrides));
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Distinct prices a service can have across the week, for the booking menu.
 * Returns the base plus any override values, deduped and sorted, so the customer
 * can be shown "from $45" or "$45-$55" before they pick a day. null entries (no
 * base price) are dropped.
 */
export function priceRangeForService(
  basePrice: number | null,
  overridesRaw: unknown,
): { min: number; max: number } | null {
  const overrides = parsePriceOverrides(overridesRaw);
  const values: number[] = [];
  if (basePrice !== null) values.push(basePrice);
  // An override only applies to its weekday; the base still covers the other
  // days UNLESS every weekday is overridden. Including the base when at least
  // one day uses it keeps the range honest; if all 7 are overridden, drop it.
  const allSevenOverridden = [0, 1, 2, 3, 4, 5, 6].every((d) =>
    Object.prototype.hasOwnProperty.call(overrides, d),
  );
  if (allSevenOverridden && basePrice !== null) values.pop();
  values.push(...Object.values(overrides));
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
