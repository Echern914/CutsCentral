/**
 * The waitlist preference-window row: one UI row of "when are you free?" and
 * how it becomes the wire shape the API stores.
 *
 * Shared by BOTH public entry points - the booking page's WaitlistForm and the
 * shop page's ShopWaitlistForm - so the two forms cannot drift on what a
 * window means, what the limits are, or what sentence the consent record
 * points at. The markup stays per-form (the shop page is theme-driven, the
 * booking page is fixed dark chrome); only the meaning lives here.
 */

/** Matches the server: MAX_WINDOWS in engines/waitlistWindows.ts. */
export const MAX_WINDOWS = 5;
/** Matches ANY_DATE_HORIZON_DAYS. Also the date inputs' `max`. */
export const HORIZON_DAYS = 14;

/** The exact sentence stored against the consent record. Keep in step with
 *  SMS_CONSENT_TEXT / SMS_CONSENT_VERSION in engines/waitlistJoin.ts. */
export const CONSENT_TEXT =
  "Text me when a spot opens up. Message and data rates may apply; " +
  "message frequency varies. Reply STOP to opt out at any time.";

/** One window on the wire: NULL means ANY on each half independently. */
export interface WaitlistWindowInput {
  startDate: string | null;
  endDate: string | null;
  startMin: number | null;
  endMin: number | null;
}

export type Row = {
  /** "any" keeps the common case one tap instead of a date picker. */
  dateMode: "any" | "on" | "between";
  startDate: string;
  endDate: string;
  timeMode: "any" | "between";
  startTime: string;
  endTime: string;
};

export const EMPTY_ROW: Row = {
  dateMode: "any",
  startDate: "",
  endDate: "",
  timeMode: "any",
  startTime: "09:00",
  endTime: "17:00",
};

/** Local YYYY-MM-DD, for the date inputs' min/max. */
export function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** "09:30" -> 570. */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** One UI row to the wire shape. Returns an error code the caller renders. */
export function rowToWindow(
  row: Row,
): { ok: true; window: WaitlistWindowInput } | { ok: false; error: string } {
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (row.dateMode === "on") {
    if (!row.startDate) return { ok: false, error: "Pick a date." };
    startDate = row.startDate;
    endDate = row.startDate;
  } else if (row.dateMode === "between") {
    if (!row.startDate || !row.endDate) return { ok: false, error: "Pick both dates." };
    if (row.startDate > row.endDate) {
      return { ok: false, error: "That date range runs backwards." };
    }
    startDate = row.startDate;
    endDate = row.endDate;
  }

  let startMin: number | null = null;
  let endMin: number | null = null;
  if (row.timeMode === "between") {
    startMin = toMinutes(row.startTime);
    endMin = toMinutes(row.endTime);
    if (startMin === null || endMin === null) {
      return { ok: false, error: "Pick a start and end time." };
    }
    if (startMin >= endMin) {
      return { ok: false, error: "The end time has to be after the start." };
    }
  }

  return { ok: true, window: { startDate, endDate, startMin, endMin } };
}

/** The customer's own IANA zone, best-effort; the server falls back to the shop's. */
export function browserTimezone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}
