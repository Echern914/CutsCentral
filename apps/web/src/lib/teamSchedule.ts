/**
 * A member's day as the API sends it (services/teamSchedule.ts): times only,
 * as ISO instants. Never a client, a service, a price or a reason - the API
 * doesn't have them to send.
 */
export interface ScheduleSpan {
  start: string;
  end: string;
}

export type NowStatus =
  | { kind: "off" }
  | { kind: "starts"; at: string }
  | { kind: "free"; until: string }
  | { kind: "busy"; until: string }
  | { kind: "away"; until: string }
  | { kind: "done" };

export interface ChairDay {
  name: string;
  hours: ScheduleSpan[];
  booked: ScheduleSpan[];
  off: ScheduleSpan[];
  free: ScheduleSpan[];
  /** Today only. */
  now: NowStatus | null;
}

export interface TeamScheduleMember {
  linkId: string;
  business: { name: string };
  /** False = they haven't shared it; `chairs` is then null. */
  shared: boolean;
  chairs: ChairDay[] | null;
}

export interface TeamScheduleData {
  /** The TEAM's timezone: every time on the page is read in it. */
  timezone: string;
  day: string;
  days: string[];
  now: string;
  members: TeamScheduleMember[];
}

/** "9:00 AM" in the team's zone. */
export function timeLabel(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(
    new Date(at),
  );
}

/** When something ENDS: "midnight", not "12:00 AM" - a day that runs to midnight read as "12:00 AM - 12:00 AM". */
export function endLabel(at: string, timezone: string): string {
  const t = timeLabel(at, timezone);
  return t === "12:00 AM" ? "midnight" : t;
}

const ALMOST_A_DAY_MS = 24 * 60 * 60 * 1000 - 60 * 1000;

/** "9:00 AM - 5:00 PM, 6:00 PM - midnight", or "All day" for a span that is the whole day. */
export function spansLabel(spans: ScheduleSpan[], timezone: string): string {
  return spans
    .map((s) =>
      Date.parse(s.end) - Date.parse(s.start) >= ALMOST_A_DAY_MS
        ? "All day"
        : `${timeLabel(s.start, timezone)} - ${endLabel(s.end, timezone)}`,
    )
    .join(", ");
}

/** A day chip: "Today", "Tomorrow", then "Sat 17". The key is the team's own date. */
export function dayChipLabel(key: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  // The key IS the calendar date: read its weekday in UTC so no zone can
  // shift it. (Intl joins weekday + day as "16 Sat"; spelled out instead.)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
  return `${weekday} ${d}`;
}

/** Where a chair is right now, in a few words, plus a tone for the chip. */
export function nowLabel(
  now: NowStatus,
  timezone: string,
): { text: string; tone: "free" | "busy" | "muted" } {
  switch (now.kind) {
    case "free":
      return { text: `Free until ${endLabel(now.until, timezone)}`, tone: "free" };
    case "busy":
      return { text: `Booked until ${endLabel(now.until, timezone)}`, tone: "busy" };
    case "away":
      return { text: `Away until ${endLabel(now.until, timezone)}`, tone: "muted" };
    case "starts":
      return { text: `In at ${timeLabel(now.at, timezone)}`, tone: "muted" };
    case "done":
      return { text: "Done for the day", tone: "muted" };
    case "off":
      return { text: "Off today", tone: "muted" };
  }
}

/** One line for the day: hours, or "Off" - and how much is booked. */
export function dayLine(chair: ChairDay, timezone: string): string {
  if (chair.hours.length === 0) {
    return chair.booked.length > 0 ? `Not working - ${chair.booked.length} booked` : "Off";
  }
  const booked = chair.booked.length === 0 ? "nothing booked" : `${chair.booked.length} booked`;
  return `${spansLabel(chair.hours, timezone)} · ${booked}`;
}

/**
 * The span every bar on the page is drawn across: from the earliest start to
 * the latest finish of any shown chair, widened to whole hours - null when
 * no one works or is booked that day, and then no bar is drawn. One scale for
 * every row, so two barbers' bars line up and can be compared at a glance.
 */
export function barRange(chairs: ChairDay[]): { from: number; to: number } | null {
  const all = chairs.flatMap((c) => [...c.hours, ...c.booked]);
  if (all.length === 0) return null;
  const HOUR = 60 * 60 * 1000;
  const from = Math.min(...all.map((s) => Date.parse(s.start)));
  const to = Math.max(...all.map((s) => Date.parse(s.end)));
  return { from: Math.floor(from / HOUR) * HOUR, to: Math.ceil(to / HOUR) * HOUR };
}
