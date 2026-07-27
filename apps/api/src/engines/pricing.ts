import { zonedDateParts, zonedMinutesOfDay } from "@chairback/config";

/**
 * Per-weekday service pricing. A service has a base `price`; `priceOverrides` is
 * a map of shop-local weekday (0=Sun..6=Sat, string keys) to the price charged
 * that day. Only days that differ from the base need an entry. The customer is
 * always shown the effective price for the date they're booking, so a Sunday
 * surcharge is never a surprise, and it's snapshotted onto priceAtBooking.
 *
 * Layered ON TOP of the weekday maps: per-service TIME-OF-DAY windows
 * (`Service.timeOverrides`, an array of {s,e,price?,durationMin?} in shop-local
 * minutes-of-day, every day). Resolution order for any instant:
 *   time window (slot START minute inside [s,e)) > weekday override > base.
 * Everything keys off the slot's START instant - a 8:45pm slot that RUNS past a
 * 9pm window boundary is priced/sized by 8:45pm's layer, exactly what the
 * customer was shown when they picked it.
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

/** One parsed time-of-day override window (shop-local minutes, e exclusive). */
export interface TimeWindow {
  s: number;
  e: number;
  price: number | null;
  durationMin: number | null;
}

/**
 * Parse the Service.timeOverrides JSON blob defensively into clean, sorted,
 * NON-overlapping windows. Write-time validation (booking.dashboard.ts) already
 * rejects overlaps and junk; this read-time defense re-applies the same rules so
 * a hand-edited row can never make the engine misprice or spin: bad entries are
 * dropped, a window overlapping an earlier (by start) kept one is dropped, and
 * an entry carrying NEITHER price nor durationMin is meaningless and dropped.
 * Accepts null/undefined (-> []) so callers can explicitly resolve "without
 * windows" (the /day service-LEVEL price does this; windows are slot-scoped).
 */
export function parseTimeWindows(raw: unknown): TimeWindow[] {
  if (!Array.isArray(raw)) return [];
  const parsed: TimeWindow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as { s?: unknown; e?: unknown; price?: unknown; durationMin?: unknown };
    const s = Number(o.s);
    const e = Number(o.e);
    if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
    if (s < 0 || s > 1439 || e < 1 || e > 1440 || e <= s) continue;
    const priceNum = o.price === null || o.price === undefined ? null : Number(o.price);
    const durNum =
      o.durationMin === null || o.durationMin === undefined ? null : Number(o.durationMin);
    const price = priceNum !== null && Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : null;
    const durationMin =
      durNum !== null && Number.isInteger(durNum) && durNum >= 5 ? durNum : null;
    if (price === null && durationMin === null) continue;
    parsed.push({ s, e, price, durationMin });
  }
  parsed.sort((a, b) => a.s - b.s);
  const out: TimeWindow[] = [];
  for (const w of parsed) {
    const last = out[out.length - 1];
    if (last && w.s < last.e) continue; // overlap -> keep the earlier window
    out.push(w);
  }
  return out;
}

/** The window containing a shop-local minute-of-day, or null. */
function windowAt(windows: TimeWindow[], minuteOfDay: number): TimeWindow | null {
  for (const w of windows) {
    if (minuteOfDay >= w.s && minuteOfDay < w.e) return w;
  }
  return null;
}

/**
 * Both effective* resolvers take their layers as ONE named-args object: the two
 * raw JSON blobs are both `unknown`, so positional params would let a swapped
 * call compile silently (and parse to harmless-looking empties). Named fields
 * make every call site self-labeling.
 */
export interface EffectiveAtArgs {
  /** The slot's START instant. */
  at: Date;
  /** Shop IANA timezone - both layers resolve in shop wall-clock, never UTC. */
  timezone: string;
  /** Service.priceOverrides / Service.durationOverrides (weekday map). */
  weekdayOverrides: unknown;
  /** Service.timeOverrides (time-of-day windows). Pass null to skip the layer. */
  timeWindows: unknown;
}

/**
 * The price in effect at an instant: its time-of-day window's price when the
 * shop-local start minute falls in one, else the weekday override for that
 * shop-local date, else the base price, else null (no price set).
 */
export function effectivePriceAt(
  basePrice: number | null,
  args: EffectiveAtArgs,
): number | null {
  const w = windowAt(
    parseTimeWindows(args.timeWindows),
    zonedMinutesOfDay(args.at, args.timezone),
  );
  if (w && w.price !== null) return w.price;
  const { weekday } = zonedDateParts(args.at, args.timezone);
  const overrides = parsePriceOverrides(args.weekdayOverrides);
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
 * The duration (minutes) in effect at an instant: its time-of-day window's
 * durationMin when the shop-local start minute falls in one, else the weekday
 * override for that shop-local date, else the base - a 9pm Thursday booking in
 * the shop's timezone uses Thursday's layers even when that instant is already
 * Friday in UTC.
 */
export function effectiveDurationAt(
  baseDurationMin: number,
  args: EffectiveAtArgs,
): number {
  const w = windowAt(
    parseTimeWindows(args.timeWindows),
    zonedMinutesOfDay(args.at, args.timezone),
  );
  if (w && w.durationMin !== null) return w.durationMin;
  const { weekday } = zonedDateParts(args.at, args.timezone);
  const overrides = parseDurationOverrides(args.weekdayOverrides);
  if (Object.prototype.hasOwnProperty.call(overrides, weekday)) {
    return overrides[weekday]!;
  }
  return baseDurationMin;
}

/** Raw layer blobs for the range helpers - same named-args rationale as above. */
export interface RangeArgs {
  weekdayOverrides: unknown;
  timeWindows: unknown;
}

/**
 * Distinct durations a service can have across the week, for menu display
 * ("30 min" or "20-30 min"). Mirrors priceRangeForService.
 */
export function durationRangeForService(
  baseDurationMin: number,
  args: RangeArgs,
): { min: number; max: number } {
  const overrides = parseDurationOverrides(args.weekdayOverrides);
  const values: number[] = [baseDurationMin];
  const allSevenOverridden = [0, 1, 2, 3, 4, 5, 6].every((d) =>
    Object.prototype.hasOwnProperty.call(overrides, d),
  );
  if (allSevenOverridden) values.pop();
  values.push(...Object.values(overrides));
  // Time-of-day windows widen the range too ("20-30 min" when evenings run
  // short). They never displace the weekday/base values: a window covers only
  // part of the day, so the underlying layer still applies outside it. (A
  // 0-1440 window would make the base value unreachable and the range a touch
  // wide - a degenerate config the booking math still prices correctly.)
  for (const w of parseTimeWindows(args.timeWindows)) {
    if (w.durationMin !== null) values.push(w.durationMin);
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Distinct prices a service can have across the week, for the booking menu.
 * Returns the base plus any weekday-override and time-window values, so the
 * customer can be shown "from $45" or "$45-$65" before they pick a slot. null
 * (no base price and no priced layers) when nothing sets a price.
 */
export function priceRangeForService(
  basePrice: number | null,
  args: RangeArgs,
): { min: number; max: number } | null {
  const overrides = parsePriceOverrides(args.weekdayOverrides);
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
  // Priced time-of-day windows widen the range (see durationRangeForService).
  for (const w of parseTimeWindows(args.timeWindows)) {
    if (w.price !== null) values.push(w.price);
  }
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
