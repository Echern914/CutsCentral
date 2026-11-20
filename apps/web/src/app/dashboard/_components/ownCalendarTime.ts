/**
 * Small date helpers for a team member's own calendar. A "day" here is always
 * a shop-local "YYYY-MM-DD" key handed out by the API; nothing in this file
 * reads the device's own timezone to decide what day it is.
 */

/** The day `n` days from a "YYYY-MM-DD" key. Pure calendar arithmetic. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", "Yesterday", or "Tue, Nov 24". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  return longDay(day);
}

/** "Tue, Nov 24" for a day key, whatever zone the device is in. */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "3:00 PM" for an instant, in the shop's zone. */
export function timeIn(timezone: string, iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The shop-local "YYYY-MM-DD" an instant falls on. */
export function dayKeyIn(timezone: string, iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** "HH:MM" to minutes from midnight ("24:00" is 1440). */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** "$45" or "$45.50" from cents. */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toFixed(whole ? 0 : 2)}`;
}

/** An id for one submission: 16 to 64 letters, digits, - or _. */
export function newSubmissionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `own-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * When a block is shown on one day's list: "All day", or "1:00 PM to 2:00 PM",
 * clipped to that day so a week away does not read as one long afternoon.
 */
export function blockSpanLabel(
  block: { startsAt: string; endsAt: string },
  day: string,
  timezone: string,
): string {
  const startsBefore = dayKeyIn(timezone, block.startsAt) < day;
  // An end exactly at the next midnight belongs to this day, not the next.
  const lastInstant = new Date(new Date(block.endsAt).getTime() - 1).toISOString();
  const endsAfter = dayKeyIn(timezone, lastInstant) > day;
  const endsAtMidnight = dayKeyIn(timezone, block.endsAt) > day;
  const startsAtMidnight = timeIn(timezone, block.startsAt) === "12:00 AM";
  if ((startsBefore || startsAtMidnight) && (endsAfter || endsAtMidnight)) return "All day";
  const from = startsBefore ? "12:00 AM" : timeIn(timezone, block.startsAt);
  const to = endsAfter || endsAtMidnight ? "the end of the day" : timeIn(timezone, block.endsAt);
  return `${from} to ${to}`;
}
