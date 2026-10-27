/**
 * BOOKING RULES IN WORDS, NOT BARE NUMBERS.
 *
 * The Booking rules card used to be five number boxes whose unit lived only in
 * the label: "Min notice (hours, 0 to 720)". A barber typed 15 meaning fifteen
 * MINUTES; it saved as fifteen hours and a same-day client was turned away.
 * Every rule is now a choice whose label carries its unit ("15 minutes",
 * "2 hours", "1 week"), and the minimum notice is stored in minutes
 * (`Shop.bookingLeadMinutes`) so fifteen minutes can actually be chosen.
 *
 * One module for the presets, the ranges and the sentences, because several
 * places say the notice out loud: the settings card, the "why am I not booked
 * out" advice, the readiness check, the receptionist's refusals. They must all
 * say "15 minutes", never "0.25 hours".
 *
 * Pure: no I/O, no clock. Imported by client components (by SUBPATH).
 */

/** Minimum notice ceiling: 30 days, the old 720-hour limit, in minutes. */
export const BOOKING_LEAD_MAX_MINUTES = 43_200;
/** What a shop gets until it chooses: two hours (the column default). */
export const BOOKING_LEAD_DEFAULT_MINUTES = 120;
/** "Book up to" range, in days (the settings API's bounds). */
export const BOOKING_MAX_DAYS_MIN = 1;
export const BOOKING_MAX_DAYS_MAX = 365;
/** Buffer between appointments, in minutes (the settings API's bounds). */
export const BOOKING_BUFFER_MAX_MIN = 240;

const MIN_PER_HOUR = 60;
const MIN_PER_DAY = 1_440;
const MIN_PER_WEEK = 10_080;

function unit(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * A length of time in the largest whole unit that reads naturally:
 * "15 minutes", "1 hour", "1 hour 30 minutes", "36 hours", "1 day",
 * "2 days", "1 week". Never a fraction ("0.25 hours"). 0 is "0 minutes" -
 * callers that mean "no limit" say so themselves.
 */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0));
  if (m < MIN_PER_HOUR) return unit(m, "minute");
  if (m % MIN_PER_WEEK === 0) return unit(m / MIN_PER_WEEK, "week");
  if (m % MIN_PER_DAY === 0) return unit(m / MIN_PER_DAY, "day");
  const hours = Math.floor(m / MIN_PER_HOUR);
  const rest = m % MIN_PER_HOUR;
  return rest === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(rest, "minute")}`;
}

/**
 * How far ahead clients may book, in days: "1 week", "2 weeks",
 * "1 month (30 days)", "1 year (365 days)", "45 days". Months are named only
 * for their exact day counts, with the days alongside, so "1 month" is never
 * mistaken for a calendar month.
 */
export function formatDaysAhead(days: number): string {
  const d = Math.max(0, Math.round(Number.isFinite(days) ? days : 0));
  if (d === 365) return "1 year (365 days)";
  if (d > 0 && d % 30 === 0 && d <= 330) return `${unit(d / 30, "month")} (${d} days)`;
  if (d > 0 && d % 7 === 0) return unit(d / 7, "week");
  return unit(d, "day");
}

/** One choice in a booking-rule dropdown. */
export interface RuleOption {
  value: number;
  label: string;
}

/**
 * The presets, plus the shop's CURRENT value when it is not one of them (an
 * older number-box save, or a value set before these presets existed), so
 * opening the card and saving never silently changes a rule. Sorted, unique.
 */
export function withCurrent(
  presets: readonly number[],
  current: number | null | undefined,
  label: (value: number) => string,
): RuleOption[] {
  const values = new Set(presets);
  if (typeof current === "number" && Number.isFinite(current)) values.add(current);
  return [...values].sort((a, b) => a - b).map((value) => ({ value, label: label(value) }));
}

//  Minimum notice ("Last-minute booking limit"), in MINUTES

export const LEAD_PRESETS_MIN: readonly number[] = [
  0, 15, 30, 45, 60, 120, 180, 240, 360, 720, 1_440, 2_880, 4_320, 10_080,
];

export function leadLabel(minutes: number): string {
  return minutes <= 0 ? "No limit" : formatDuration(minutes);
}

export function leadOptions(currentMinutes: number | null | undefined): RuleOption[] {
  return withCurrent(LEAD_PRESETS_MIN, currentMinutes, leadLabel);
}

/** The sentence under the control, and the one other surfaces repeat. */
export function describeLead(minutes: number): string {
  return minutes <= 0
    ? "No limit: clients can book any open time, even one starting soon."
    : `Clients must book at least ${formatDuration(minutes)} ahead.`;
}

/** The settings API: whole minutes, 0 to 30 days. */
export function isValidLeadMinutes(minutes: unknown): minutes is number {
  return (
    typeof minutes === "number" &&
    Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes <= BOOKING_LEAD_MAX_MINUTES
  );
}

/**
 * The legacy whole-hours column, kept in step with the minutes one so code
 * deployed before minutes existed never reads a SHORTER notice than the shop
 * set: 15 minutes is stored as 1 hour there, never 0.
 */
export function leadMinutesToLegacyHours(minutes: number): number {
  return Math.ceil(Math.max(0, minutes) / MIN_PER_HOUR);
}

//  How far ahead ("Future booking limit"), in DAYS

export const MAX_DAYS_PRESETS: readonly number[] = [7, 14, 21, 30, 60, 90, 180, 365];

export function maxDaysOptions(currentDays: number | null | undefined): RuleOption[] {
  return withCurrent(MAX_DAYS_PRESETS, currentDays, formatDaysAhead);
}

export function describeMaxDays(days: number): string {
  return `Clients can book up to ${formatDaysAhead(days)} ahead.`;
}

//  Buffer between appointments, in MINUTES

export const BUFFER_PRESETS_MIN: readonly number[] = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];

export function bufferLabel(minutes: number): string {
  return minutes <= 0 ? "None" : formatDuration(minutes);
}

export function bufferOptions(currentMinutes: number | null | undefined): RuleOption[] {
  return withCurrent(BUFFER_PRESETS_MIN, currentMinutes, bufferLabel);
}

/** The buffer must FIT after every slot, the day's last included - say so. */
export function describeBuffer(minutes: number): string {
  if (minutes <= 0) return "No gap: bookings can run back to back.";
  const d = formatDuration(minutes);
  return `${d} of breathing room after every booking. The last slot of the day needs its buffer too, so the final booking ends ${d} before closing.`;
}

//  Reschedule / cancel cutoffs, in HOURS (0 = anytime)

export const CUTOFF_PRESETS_HOURS: readonly number[] = [0, 1, 2, 3, 4, 6, 12, 24, 48, 72, 168];

export function cutoffLabel(hours: number): string {
  return hours <= 0 ? "Anytime" : `${formatDuration(hours * MIN_PER_HOUR)} before`;
}

/** Presets up to `maxHours` (a week for both cutoffs), plus the current value. */
export function cutoffOptions(currentHours: number | null | undefined, maxHours: number): RuleOption[] {
  return withCurrent(
    CUTOFF_PRESETS_HOURS.filter((h) => h <= maxHours),
    currentHours,
    cutoffLabel,
  );
}
