import { ANY_DATE_HORIZON_DAYS, isValidTimezone } from "./waitlistWindows.js";

/**
 * Waitlist phase D: preference-aware matching. PURE - no database, no clock
 * reads, no side effects. pickCandidate (engines/waitlistOffer.ts) feeds it
 * candidates in ranked order; the evidence script feeds it the same rows to
 * print a per-candidate trace. One implementation, two consumers, so what the
 * matcher DOES and what it SAYS it did can never drift.
 *
 * The contract, in the customer's own clock:
 *
 *   - The slot's start/end INSTANTS are converted into the ENTRY's validated
 *     IANA timezone (bad/missing zone -> the shop's). "Saturday morning"
 *     means the customer's Saturday morning, not the server's.
 *   - Date half of a window: NULL = Any Date, which respects the SAME 14-day
 *     horizon the join UI sold ("in the next 14 days") - evaluated ROLLING
 *     from the offer moment, in the entry's zone. Anchoring it at join time
 *     would silently kill every long-standing entry, including the 118
 *     migrated ones whose whole meaning was "standing, until I say stop".
 *     A specific date matches exactly; a range is inclusive on both ends.
 *   - Time half: NULL = Any Time. A concrete range demands the WHOLE
 *     appointment inside it - start at/after the preferred start AND end
 *     at/before the preferred end. A 5:30 cut never matches "until 6" if it
 *     runs to 6:15, no matter how well the start fits.
 *   - Windows OR together: fitting ANY one qualifies the entry.
 *   - minHoursNotice: the slot must start at least that many hours after
 *     "now" (and always strictly in the future, notice set or not).
 *
 * Wall-clock arithmetic, deliberately: on a DST transition day the customer's
 * "9:00-12:00" is about what their kitchen clock says, so both ends of the
 * slot are compared as WALL times. An appointment that crosses local midnight
 * can only satisfy Any Time - no stored window (endMin <= 1440) can contain
 * it, and "matches Friday evening" would be a lie about half of it.
 */

export interface MatchWindow {
  startDate: string | null; // YYYY-MM-DD, entry-local
  endDate: string | null;
  startMin: number | null; // minutes from local midnight
  endMin: number | null;
}

export interface MatchEntryShape {
  timezone: string | null;
  minHoursNotice: number | null;
  windows: MatchWindow[];
}

export interface MatchSlotShape {
  startsAt: Date;
  endsAt: Date;
}

export type MatchVerdict = { ok: true; detail: string } | { ok: false; reason: string };

// One formatter per zone for the whole process - building Intl.DateTimeFormat
// is the expensive part, and a large-waitlist scan calls this per candidate.
const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FMT_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    FMT_CACHE.set(tz, f);
  }
  return f;
}

/** An instant as the wall clock of `tz` sees it. */
export function wallParts(at: Date, tz: string): { date: string; minutes: number } {
  const parts = formatterFor(tz).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/** "2026-08-24" + n days, pure calendar arithmetic (UTC, no zone effects). */
export function addDaysToDateKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(
    t.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** The zone matching actually runs in: the entry's when valid, else the shop's. */
export function resolveMatchTimezone(entryTz: string | null, shopTz: string): string {
  return entryTz && isValidTimezone(entryTz) ? entryTz : shopTz;
}

/**
 * The slot as the entry's wall clock sees it. endMinutes is on the START
 * day's scale: exactly-midnight ends read 1440 (they fit a "...to midnight"
 * window); anything past midnight reads > 1440 and can only match Any Time.
 */
export function slotWallView(
  slot: MatchSlotShape,
  tz: string,
): { date: string; startMinutes: number; endMinutes: number } {
  const start = wallParts(slot.startsAt, tz);
  const end = wallParts(slot.endsAt, tz);
  let endMinutes: number;
  if (end.date === start.date) {
    endMinutes = end.minutes;
  } else if (end.date === addDaysToDateKey(start.date, 1) && end.minutes === 0) {
    endMinutes = 1440; // ends exactly at the stroke of local midnight
  } else {
    endMinutes = 1441 + end.minutes; // crosses midnight: > any storable window
  }
  return { date: start.date, startMinutes: start.minutes, endMinutes };
}

/** Human label for a window, used by skip reasons and the evidence trace. */
export function describeMatchWindow(w: MatchWindow): string {
  const date =
    w.startDate === null || w.endDate === null
      ? "Any date"
      : w.startDate === w.endDate
        ? w.startDate
        : `${w.startDate}..${w.endDate}`;
  const time =
    w.startMin === null || w.endMin === null
      ? "Any time"
      : `${clock(w.startMin)}-${clock(w.endMin)}`;
  return `${date} @ ${time}`;
}

function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * Does the slot fit ONE window? Returns a reason either way - the trace and
 * the tests read them, so say exactly which half failed.
 */
export function windowFits(
  w: MatchWindow,
  view: { date: string; startMinutes: number; endMinutes: number },
  todayInTz: string,
): MatchVerdict {
  const label = describeMatchWindow(w);

  // ---- date half ----
  if (w.startDate === null || w.endDate === null) {
    // Any Date = the same "next 14 days" the join UI sold, rolling from now.
    const horizonEnd = addDaysToDateKey(todayInTz, ANY_DATE_HORIZON_DAYS);
    if (view.date < todayInTz || view.date > horizonEnd) {
      return {
        ok: false,
        reason: `[${label}] slot date ${view.date} outside the rolling ${ANY_DATE_HORIZON_DAYS}-day Any-Date horizon (${todayInTz}..${horizonEnd})`,
      };
    }
  } else if (view.date < w.startDate || view.date > w.endDate) {
    return { ok: false, reason: `[${label}] slot date ${view.date} not in range` };
  }

  // ---- time half: the WHOLE appointment must fit ----
  if (w.startMin !== null && w.endMin !== null) {
    if (view.startMinutes < w.startMin) {
      return {
        ok: false,
        reason: `[${label}] slot starts ${clock(view.startMinutes)}, before the preferred start`,
      };
    }
    if (view.endMinutes > w.endMin) {
      return {
        ok: false,
        reason: `[${label}] slot ends ${
          view.endMinutes > 1440 ? "past midnight" : clock(view.endMinutes)
        }, after the preferred end - a fitting start is not enough`,
      };
    }
  }

  return {
    ok: true,
    detail: `[${label}] fits: ${view.date} ${clock(view.startMinutes)}-${
      view.endMinutes > 1440 ? "past-midnight" : clock(view.endMinutes)
    }`,
  };
}

/**
 * The whole preference test for one entry against one slot: minimum notice,
 * then the windows OR'd together. Service/staff/cooldown/live-offer/same-slot
 * filters live in the database query (pickCandidate) - by the time an entry
 * reaches here those are already true.
 */
export function entryPrefsMatchSlot(
  entry: MatchEntryShape,
  slot: MatchSlotShape,
  opts: { shopTimezone: string; now: Date },
): MatchVerdict {
  // Past, or inside the entry's own minimum notice. (A null notice still
  // demands a strictly-future slot.)
  const leadMs = Math.max(0, entry.minHoursNotice ?? 0) * 3_600_000;
  const earliest = opts.now.getTime() + leadMs;
  if (slot.startsAt.getTime() < earliest || slot.startsAt.getTime() <= opts.now.getTime()) {
    return {
      ok: false,
      reason:
        entry.minHoursNotice != null
          ? `needs ${entry.minHoursNotice}h notice; slot starts too soon`
          : "slot is not in the future",
    };
  }

  const tz = resolveMatchTimezone(entry.timezone, opts.shopTimezone);
  const view = slotWallView(slot, tz);
  const today = wallParts(opts.now, tz).date;

  // Defensive: an entry with no window rows (nothing pre-dates the phase-A
  // backfill, but a raw insert could) means what the backfill meant - Any/Any.
  const windows: MatchWindow[] =
    entry.windows.length > 0
      ? entry.windows
      : [{ startDate: null, endDate: null, startMin: null, endMin: null }];

  const reasons: string[] = [];
  for (const w of windows) {
    const v = windowFits(w, view, today);
    if (v.ok) return { ok: true, detail: `${v.detail} (tz ${tz})` };
    reasons.push(v.reason);
  }
  return { ok: false, reason: `no window fits: ${reasons.join("; ")} (tz ${tz})` };
}
