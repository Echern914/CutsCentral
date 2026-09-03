import { zonedDateParts } from "./time.js";

/**
 * "How long until my appointment?" — answered the way a person would.
 *
 * ONE implementation, shared by the manage page, the customer app's next-visit
 * card and anything else that wants to say "in 3 days". Two rules that are
 * easy to get wrong on their own:
 *
 *  - Under a day, count REAL time ("in 2 hours"). Over a day, count CALENDAR
 *    days in the SHOP's time zone: an appointment at 9am tomorrow is "tomorrow"
 *    at 11pm tonight even though it is only ten hours away, because that is
 *    how the customer thinks about it - and it is what the reminder that fires
 *    "the day before" means, too.
 *  - Never round a near future down to nothing. "in 0 minutes" is a bug;
 *    "right now" is an answer.
 *
 * Returns null once the start has passed, so a caller renders nothing rather
 * than "in -3 hours". The appointment's own status says what happened next.
 */
export function untilLabel(startsAt: Date, now: Date, timezone: string): string | null {
  const ms = startsAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "right now";
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes - hours * 60;
    // Close in, the minutes matter ("in 1 hour 20 minutes"); further out they
    // are noise ("in 9 hours").
    const tail = hours < 3 && rest > 0 ? ` ${rest} ${rest === 1 ? "minute" : "minutes"}` : "";
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}${tail}`;
  }

  const days = calendarDaysBetween(now, startsAt, timezone);
  if (days <= 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}

/** Whole calendar days from `from` to `to`, counted on the wall clock of `timezone`. */
function calendarDaysBetween(from: Date, to: Date, timezone: string): number {
  const a = zonedDateParts(from, timezone);
  const b = zonedDateParts(to, timezone);
  const ua = Date.UTC(a.year, a.month0, a.day);
  const ub = Date.UTC(b.year, b.month0, b.day);
  return Math.round((ub - ua) / 86_400_000);
}
