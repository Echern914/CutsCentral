/**
 * Dates and times, always on the SHOP's wall clock.
 *
 * An appointment happens where the shop is. A customer who travels, or whose
 * phone is set to another zone, must still read "2:30 PM" for a 2:30 cut - so
 * every formatter here takes the shop's IANA zone, and nothing reads the
 * device's zone except the greeting.
 *
 * `untilLabel` mirrors packages/config/src/relativeTime.ts (the manage page's
 * and the emails' countdown) rule for rule, so the app never disagrees with
 * the message that brought the customer here. Its test pins the same cases.
 */

interface ZonedParts {
  year: number;
  month0: number;
  day: number;
}

function zonedParts(d: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month0: get("month") - 1, day: get("day") };
}

function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  const a = zonedParts(from, timeZone);
  const b = zonedParts(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month0, b.day) - Date.UTC(a.year, a.month0, a.day)) / 86_400_000);
}

/** "in 45 minutes" · "tomorrow" · "in 3 days" · "in 2 weeks" · null once started. */
export function untilLabel(startsAt: Date, now: Date, timeZone: string): string | null {
  const ms = startsAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "right now";
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes - hours * 60;
    const tail = hours < 3 && rest > 0 ? ` ${rest} ${rest === 1 ? "minute" : "minutes"}` : "";
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}${tail}`;
  }
  const days = calendarDaysBetween(now, startsAt, timeZone);
  if (days <= 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}

/** "Thursday, Sep 18" - "Today" / "Tomorrow" when that is the truer answer. */
export function dayLabel(iso: string, timeZone: string, now = new Date()): string {
  const d = new Date(iso);
  const days = calendarDaysBetween(now, d, timeZone);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  const sameYear = zonedParts(now, timeZone).year === zonedParts(d, timeZone).year;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** "2:30 PM" */
export function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "2:30 – 3:00 PM", or just the start when there is no end. */
export function timeRange(startIso: string, endIso: string | null, timeZone: string): string {
  const start = timeLabel(startIso, timeZone);
  if (!endIso) return start;
  const end = timeLabel(endIso, timeZone);
  const [startClock, startMeridiem] = start.split(" ");
  const [, endMeridiem] = end.split(" ");
  // One meridiem when both share it: "2:30 – 3:00 PM", as a person writes it.
  return startMeridiem === endMeridiem ? `${startClock} – ${end}` : `${start} – ${end}`;
}

/** "Aug 28" this year, "Aug 28, 2025" otherwise. */
export function shortDate(iso: string, timeZone: string, now = new Date()): string {
  const d = new Date(iso);
  const sameYear = zonedParts(now, timeZone).year === zonedParts(d, timeZone).year;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** The calendar block beside a history row: { month: "Sep", day: "18" }. */
export function calendarBlock(iso: string, timeZone: string): { month: string; day: string } {
  const d = new Date(iso);
  return {
    month: new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(d),
    day: new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(d),
  };
}

/** The spoken form for VoiceOver: "Thursday, September 18 at 2:30 PM". */
export function spokenWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(d);
  return `${day} at ${timeLabel(iso, timeZone)}`;
}

/** Greeting by the DEVICE's clock - the one place the customer's own time is right. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** "(646) 555-0123" for a North American E.164; anything else as stored. */
export function displayPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Up to two initials for a monogram: "Alpha Cuts" -> "AC", "drickcuttinup" -> "D". */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** "2 of 5 visits" / "6 of 10 punches". */
export function progressLine(balance: number, cost: number, unit: "visits" | "punches"): string {
  const shown = Math.min(balance, cost);
  return `${shown} of ${cost} ${unit === "visits" ? (cost === 1 ? "visit" : "visits") : cost === 1 ? "punch" : "punches"}`;
}

/** "3 more visits until $10 off" / "1 more punch until a free treatment". */
export function remainingLine(remaining: number, rewardName: string, unit: "visits" | "punches"): string {
  const noun = unit === "visits" ? (remaining === 1 ? "visit" : "visits") : remaining === 1 ? "punch" : "punches";
  return `${remaining} more ${noun} until ${rewardName}`;
}
