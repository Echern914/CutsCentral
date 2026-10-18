/**
 * "How many slots do I have open next week?" - answered from THIS shop's own
 * calendar.
 *
 * Drick asked it (2026-10-18) and got "I don't have that one written up
 * exactly". The API now counts the open times (apps/api
 * services/openSlotsFacts.ts) with the SAME slot engine the public booking
 * page uses, and the support engine renders the count with `openSlotsText`.
 *
 * 🔴 WHAT ONE "OPEN TIME" IS. A start time the booking page would offer right
 * now, for one chair, for that chair's usual service (its most-booked service
 * over the last 90 days, else the first one it offers). Each chair is counted
 * ONCE - never once per service, which would count one free half hour three
 * times for a shop with three services. Times inside the booking notice, or
 * past how far ahead clients may book, are not open, exactly as on the page.
 *
 * 🔴 NO MODEL, NO CLOCK. Every sentence is a template filled with a counted
 * number. "Today" comes from the brief (the shop's local date when the API
 * counted), never from this machine's clock, so the answer is a pure function
 * of the brief and the question.
 *
 * This file is the WIRE shape plus that renderer, so the API, the support
 * engine and the web agree on one structure. It carries counts only - never a
 * client's name and never money.
 */

export interface OpenSlotsDay {
  /** The shop-local date, YYYY-MM-DD. */
  date: string;
  /** Shop-local weekday, 0-6 (Sun-Sat). */
  weekday: number;
  /** Start times still bookable that day. */
  open: number;
  /**
   * Start times the day would offer with nothing booked: hours less breaks
   * and blocked-off time. 0 means closed (or, today, nothing left).
   */
  capacity: number;
}

export interface OpenSlotsBrief {
  /** "shop" for an owner or manager; "own" for a provider's own chair. */
  scope: "shop" | "own";
  /** The shop-local date the count was taken on, YYYY-MM-DD. */
  today: string;
  /** Today through the Sunday of next week, in order. */
  days: OpenSlotsDay[];
  /** How many chairs were counted. */
  chairs: number;
  /**
   * The service counted, as "Cut (30 min)", when every chair counted the same
   * one; null when chairs counted different services.
   */
  service: string | null;
  /** Where clients book, or null when there is no page that would open. */
  bookingUrl: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_WORDS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A YYYY-MM-DD date moved by whole days (calendar arithmetic, no zones). */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0-6 (Sun-Sat) for a YYYY-MM-DD date. */
function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function monthDay(ymd: string): { month: string; day: number } {
  const [, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return { month: MONTHS[m - 1]!, day: d };
}

/** "Oct 19-25", or "Oct 26-Nov 1" across a month. */
function rangeLabel(from: string, to: string): string {
  const a = monthDay(from);
  const b = monthDay(to);
  if (from === to) return `${a.month} ${a.day}`;
  return a.month === b.month ? `${a.month} ${a.day}-${b.day}` : `${a.month} ${a.day}-${b.month} ${b.day}`;
}

export interface OpenSlotsWindow {
  /** How the answer names the window: "Next week (Oct 19-25)". */
  label: string;
  from: string;
  to: string;
}

/**
 * Which days the question is about. Week = Monday-Sunday in the shop's
 * timezone; "this week" is what is left of it. No period named: this week and
 * next week, which is what "how many slots do I have open" most often means.
 */
export function openSlotsWindows(question: string, today: string): OpenSlotsWindow[] {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  // Monday-based: 0 = Monday ... 6 = Sunday.
  const sinceMonday = (weekdayOf(today) + 6) % 7;
  const thisSunday = addDays(today, 6 - sinceMonday);
  const nextMonday = addDays(thisSunday, 1);
  const nextSunday = addDays(nextMonday, 6);
  const thisWeek: OpenSlotsWindow = {
    label: `The rest of this week (${rangeLabel(today, thisSunday)})`,
    from: today,
    to: thisSunday,
  };
  const nextWeek: OpenSlotsWindow = {
    label: `Next week (${rangeLabel(nextMonday, nextSunday)})`,
    from: nextMonday,
    to: nextSunday,
  };

  if (/ next week /.test(q)) return [nextWeek];
  if (/ this week /.test(q)) return [thisWeek];
  if (/ tomorrow /.test(q)) {
    const t = addDays(today, 1);
    return [{ label: `Tomorrow (${WEEKDAYS[weekdayOf(t)]} ${rangeLabel(t, t)})`, from: t, to: t }];
  }
  if (/ (today|tonight) /.test(q)) {
    return [{ label: `Today (${WEEKDAYS[weekdayOf(today)]} ${rangeLabel(today, today)})`, from: today, to: today }];
  }
  // A named weekday: its next date, today included.
  for (let w = 0; w < 7; w++) {
    if (q.includes(` ${WEEKDAY_WORDS[w]} `) || q.includes(` ${WEEKDAY_WORDS[w]}s `)) {
      const ahead = (w - weekdayOf(today) + 7) % 7;
      const d = addDays(today, ahead);
      return [{ label: `${WEEKDAY_WORDS[w]![0]!.toUpperCase()}${WEEKDAY_WORDS[w]!.slice(1)} (${rangeLabel(d, d)})`, from: d, to: d }];
    }
  }
  return [thisWeek, nextWeek];
}

/** "4", "0 (full)", "closed" - one day's state in a few characters. */
function dayState(day: OpenSlotsDay, today: string): string {
  if (day.capacity === 0) return day.date === today ? "none left" : "closed";
  return day.open === 0 ? "0 (full)" : String(day.open);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One window as a paragraph. */
function windowText(brief: OpenSlotsBrief, w: OpenSlotsWindow): string {
  const days = brief.days.filter((d) => d.date >= w.from && d.date <= w.to);
  if (days.length === 0) {
    return `${w.label}: I couldn't count that far ahead.`;
  }
  const open = days.reduce((s, d) => s + d.open, 0);
  const capacity = days.reduce((s, d) => s + d.capacity, 0);
  const where = brief.scope === "own" ? "on your chair" : brief.chairs === 1 ? "" : `across ${brief.chairs} chairs`;
  const head = `${w.label} you have ${plural(open, "open time", "open times")}${where ? ` ${where}` : ""}`;

  if (capacity === 0) {
    return `${head} - nothing is open for booking those days.`;
  }
  const lines: string[] = [];
  if (days.length === 1) {
    lines.push(`${head}, of ${capacity} your hours offer.`);
  } else {
    const breakdown = days.map((d) => `${WEEKDAYS[d.weekday]} ${dayState(d, brief.today)}`).join(", ");
    lines.push(`${head}: ${breakdown}.`);
    lines.push(`That's ${open} of the ${capacity} times your hours offer still open.`);
    // Busiest = the smallest share still open, among days that open at all.
    const working = days.filter((d) => d.capacity > 0);
    if (working.length >= 2) {
      const share = (d: OpenSlotsDay) => d.open / d.capacity;
      const least = Math.min(...working.map(share));
      const busiest = working.filter((d) => share(d) === least);
      if (least < 1) {
        const names = busiest.map((d) => WEEKDAYS[d.weekday]).join(" and ");
        lines.push(
          least === 0
            ? `Busiest: ${names} (full).`
            : `Busiest: ${names} (${busiest.map((d) => `${d.open} of ${d.capacity} left`).join(", ")}).`,
        );
      }
    }
  }
  return lines.join(" ");
}

/** The whole answer body, paragraphs separated by a blank line. */
export function openSlotsText(brief: OpenSlotsBrief, question: string): string {
  const parts = openSlotsWindows(question, brief.today).map((w) => windowText(brief, w));
  const service = brief.service ? `for ${brief.service}` : "for each chair's usual service";
  parts.push(
    `An open time is a start time your booking page offers ${service}, counted once per chair - not once per service.`,
  );
  if (brief.bookingUrl) parts.push(`Your booking page: ${brief.bookingUrl}`);
  return parts.join("\n\n");
}
