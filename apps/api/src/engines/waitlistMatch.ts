import { isValidTimezone } from "./waitlistWindows.js";

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
 *   - Date half of a window: dates are stored CONCRETE. "Any Date" is
 *     materialized AT JOIN into an explicit [join date .. join date + 14]
 *     window in the entry's zone (Acuity's "any opening in the next 14
 *     days"), so matching only ever range-checks what was stored - it never
 *     recomputes eligibility from the offer moment. Past the stored end
 *     date the entry simply stops matching; phase F will mark it EXPIRED.
 *   - 🔑 GRANDFATHERED LEGACY: a window with NULL dates predates the fixed
 *     materialization - the 118 backfilled entries (plus any joined before
 *     this change). Their stored NULL is the deliberate marker: they match
 *     ANY date, unlimited, until phase F applies an explicit legacy-
 *     expiration policy. New joins can never mint one (the join route
 *     materializes), so NULL dates <=> legacy, by construction.
 *   - A specific date matches exactly; a range is inclusive on both ends.
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
 *
 * 🔴 LOG HYGIENE: every verdict carries BOTH a machine `code` and a human
 * `reason`. Production logs record the code and ids ONLY - the reason string
 * names dates and time windows (a customer's preferences) and is for tests
 * and the isolated evidence trace, never for log lines.
 */

export interface MatchWindow {
  startDate: string | null; // YYYY-MM-DD entry-local; NULL = grandfathered legacy
  endDate: string | null;
  startMin: number | null; // minutes from local midnight; NULL = any time
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

/** Machine-readable skip reasons - the ONLY matcher output that may be logged. */
export type MatchSkipCode =
  | "past_slot"
  | "min_notice"
  | "date_out_of_range"
  | "time_does_not_fit"
  | "no_window_fits";

export type MatchVerdict =
  | { ok: true; detail: string }
  | { ok: false; code: MatchSkipCode; reason: string };

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
      ? "Any date (legacy)"
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
 * Does the slot fit ONE window? Returns a coded reason either way - the
 * trace and the tests read the words, production logs read only the code.
 */
export function windowFits(
  w: MatchWindow,
  view: { date: string; startMinutes: number; endMinutes: number },
): MatchVerdict {
  const label = describeMatchWindow(w);

  // ---- date half ----
  // NULL dates = grandfathered legacy (see the header): any date matches,
  // deliberately, until phase F's explicit legacy-expiration policy. Every
  // OTHER window is a stored concrete range - including materialized
  // "Any Date" joins - and is range-checked exactly as stored. Nothing here
  // looks at "today": eligibility was fixed at join time.
  if (w.startDate !== null && w.endDate !== null) {
    if (view.date < w.startDate || view.date > w.endDate) {
      return {
        ok: false,
        code: "date_out_of_range",
        reason: `[${label}] slot date ${view.date} not in range`,
      };
    }
  }

  // ---- time half: the WHOLE appointment must fit ----
  if (w.startMin !== null && w.endMin !== null) {
    if (view.startMinutes < w.startMin) {
      return {
        ok: false,
        code: "time_does_not_fit",
        reason: `[${label}] slot starts ${clock(view.startMinutes)}, before the preferred start`,
      };
    }
    if (view.endMinutes > w.endMin) {
      return {
        ok: false,
        code: "time_does_not_fit",
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
/**
 * Has this window's last usable moment already passed? (Phase F2.)
 *
 * `deadline` is the entry's OWN wall clock at `now + minHoursNotice`, so the
 * comparison happens entirely in the space the windows are written in. Nothing
 * here converts a wall time back to an instant - which is exactly why it is
 * DST-safe: spring-forward's missing hour and fall-back's repeated hour are
 * problems for CONSTRUCTING a local time, and this only ever reads one.
 *
 * 🔴 A null endDate is a grandfathered legacy row and can NEVER be past. Those
 * entries stay live until phase F3's deliberate policy converts them; the
 * sweeper must not decide it by accident.
 *
 * `endMin ?? 1440` is "to the stroke of local midnight", matching both the
 * validator (which caps endMin at 1440) and slotWallView, where a slot ending
 * exactly at midnight reads 1440.
 */
export function windowIsPast(
  w: MatchWindow,
  deadline: { date: string; minutes: number },
): boolean {
  if (w.endDate === null) return false; // legacy Any Date - never expires here
  if (deadline.date > w.endDate) return true;
  if (deadline.date < w.endDate) return false;
  return deadline.minutes >= (w.endMin ?? 1440);
}

/**
 * Can this entry never match anything again?
 *
 * WHY IT CANNOT EXPIRE SOMEONE STILL MATCHABLE. entryPrefsMatchSlot only says
 * yes for a slot that starts at or after `now + notice` AND whose wall-clock
 * END is inside a window. Since endsAt > startsAt, any matchable slot must
 * START strictly before its window's closing instant. So once the deadline has
 * reached that instant, no future slot can satisfy the window - and if that is
 * true of every window, the entry is finished.
 *
 * The converse is deliberately NOT claimed: an entry whose only service is too
 * long to fit its remaining window is still reported live. This under-expires,
 * which is the safe direction - a person waiting one day too long costs
 * nothing, a person dropped a day early loses their place.
 *
 * An entry with no window rows is treated the way the matcher treats it: as
 * grandfathered Any/Any, i.e. never expiring.
 */
export function entryIsExpired(
  entry: MatchEntryShape,
  opts: { shopTimezone: string; now: Date },
): boolean {
  if (entry.windows.length === 0) return false;
  const tz = resolveMatchTimezone(entry.timezone, opts.shopTimezone);
  const leadMs = Math.max(0, entry.minHoursNotice ?? 0) * 3_600_000;
  const at = new Date(opts.now.getTime() + leadMs);

  // 🔴 THE FALL-BACK FOLD. A wall clock is monotonic except when it is set
  // BACK, and then the same wall time happens twice. On 2026-11-01 in New
  // York, 01:30 occurs at 05:30 UTC and again at 06:30 UTC - so a window
  // ending 01:30 looks finished at the first pass while an hour of instants
  // still inside it is yet to come. Expiring there would be the one thing
  // this rule promises never to do.
  //
  // Detect only the direction that can un-expire (the offset moving
  // backwards) and defer to the next tick; hourly, that costs at most an
  // hour, once or twice a year. A spring-forward moves the offset the other
  // way and cannot resurrect a passed window, so the exact boundary is kept
  // in every other case - including the transition itself.
  if (zoneOffsetMinutes(new Date(at.getTime() + FOLD_GUARD_MS), tz) < zoneOffsetMinutes(at, tz)) {
    return false;
  }

  const deadline = wallParts(at, tz);
  return entry.windows.every((w) => windowIsPast(w, deadline));
}

/** How far ahead to look for a clock about to be set back. Comfortably past
 *  the largest shift any IANA zone uses (1h; Lord Howe's is 30m). */
const FOLD_GUARD_MS = 2 * 3_600_000;

/** The zone's UTC offset at an instant, in minutes, from wall parts alone. */
function zoneOffsetMinutes(at: Date, tz: string): number {
  const { date, minutes } = wallParts(at, tz);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wallEpochMin = Math.floor(Date.UTC(y, m - 1, d) / 60_000) + minutes;
  return wallEpochMin - Math.floor(at.getTime() / 60_000);
}

export function entryPrefsMatchSlot(
  entry: MatchEntryShape,
  slot: MatchSlotShape,
  opts: { shopTimezone: string; now: Date },
): MatchVerdict {
  // Past, or inside the entry's own minimum notice. (A null notice still
  // demands a strictly-future slot.)
  const leadMs = Math.max(0, entry.minHoursNotice ?? 0) * 3_600_000;
  const earliest = opts.now.getTime() + leadMs;
  if (slot.startsAt.getTime() <= opts.now.getTime()) {
    return { ok: false, code: "past_slot", reason: "slot is not in the future" };
  }
  if (slot.startsAt.getTime() < earliest) {
    return {
      ok: false,
      code: "min_notice",
      reason: `needs ${entry.minHoursNotice}h notice; slot starts too soon`,
    };
  }

  const tz = resolveMatchTimezone(entry.timezone, opts.shopTimezone);
  const view = slotWallView(slot, tz);

  // Defensive: an entry with no window rows (nothing post-dates the phase-A
  // backfill without one, but a raw insert could) means what the backfill
  // meant - grandfathered Any/Any.
  const windows: MatchWindow[] =
    entry.windows.length > 0
      ? entry.windows
      : [{ startDate: null, endDate: null, startMin: null, endMin: null }];

  const reasons: string[] = [];
  for (const w of windows) {
    const v = windowFits(w, view);
    if (v.ok) return { ok: true, detail: `${v.detail} (tz ${tz})` };
    reasons.push(v.reason);
  }
  return {
    ok: false,
    code: "no_window_fits",
    reason: `no window fits: ${reasons.join("; ")} (tz ${tz})`,
  };
}
