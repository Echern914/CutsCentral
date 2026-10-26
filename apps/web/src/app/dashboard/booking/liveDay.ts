import {
  fillOpenings,
  openingConflict,
  type OpeningConflict,
  type Span,
} from "@chairback/config/specialDay";
import type { DayView, DayViewChair } from "./actions";

/**
 * The live view's DRAFT: the openings the barber is shaping on each chair,
 * before he saves. Pure functions, so the rules are tested without a screen.
 *
 * Every placement decision goes through config/specialDay.ts - the same rule
 * the server applies when it saves - so the view never shows an opening the
 * save would refuse.
 */

export interface DraftOpening {
  /** Stable React key; the server id when the opening already exists. */
  key: string;
  /** The saved opening this is (absent = new, not saved yet). */
  id?: string;
  startMin: number;
  durationMin: number;
  price: number;
  booked: boolean;
}

export type Draft = Record<string, DraftOpening[]>;

let seq = 0;
function newKey(): string {
  seq += 1;
  return `new-${seq}`;
}

const byStart = (a: DraftOpening, b: DraftOpening) => a.startMin - b.startMin;

/** The draft that matches the saved day exactly (nothing to save). */
export function draftFromView(view: DayView): Draft {
  const out: Draft = {};
  for (const c of view.chairs) {
    out[c.staffId] = c.openings.map((o) => ({
      key: o.id,
      id: o.id,
      startMin: o.startMin,
      durationMin: o.durationMin,
      price: o.price,
      booked: o.booked,
    }));
  }
  return out;
}

/** The barber chose to open special times over his OWN block-off that day. */
export interface PlaceOptions {
  overOwnBlocks?: boolean;
}

/**
 * What is on a chair, as minute spans, for the shared placement rule. With
 * `overOwnBlocks` the barber's own block-offs that day (ownBlockId) are left
 * out - exactly what the server's save does - never a booking, a weekly break
 * or an Acuity block.
 */
export function chairSpans(chair: DayViewChair, opts: PlaceOptions = {}) {
  const span = (i: { startMin: number; endMin: number }): Span => ({ start: i.startMin, end: i.endMin });
  return {
    bookings: chair.bookings.map(span),
    external: chair.external.map(span),
    blocks: chair.blocks.filter((b) => !(opts.overOwnBlocks && b.ownBlockId)).map(span),
  };
}

/**
 * Why `opening` cannot sit on this chair next to the chair's OTHER draft
 * openings (`skipKey` = the opening itself, when moving one), or null.
 */
export function placementProblem(
  view: DayView,
  chair: DayViewChair,
  draft: DraftOpening[],
  opening: { startMin: number; durationMin: number },
  skipKey?: string,
  opts: PlaceOptions = {},
): OpeningConflict | null {
  return openingConflict({ start: opening.startMin, end: opening.startMin + opening.durationMin }, chairSpans(chair, opts), {
    buffer: view.bufferMin,
    now: view.nowMin,
    others: draft
      .filter((d) => d.key !== skipKey)
      .map((d) => ({ start: d.startMin, end: d.startMin + d.durationMin })),
    dayStart: 0,
    dayEnd: 1440,
  });
}

/**
 * FILL THE DAY on one chair: "every 20 min from 9:00 to 5:00 at $65". Booked
 * openings stay; every other opening is replaced by the generated set, minus
 * the ones that would sit on a booking or blocked time (returned as skipped).
 * An unbooked opening already saved at exactly a generated time keeps its id,
 * so re-filling a published day only re-prices it rather than replacing rows.
 */
export function fillChair(
  view: DayView,
  chair: DayViewChair,
  current: DraftOpening[],
  spec: { startMin: number; endMin: number; cutMin: number; price: number },
  opts: PlaceOptions = {},
): { openings: DraftOpening[]; skipped: { startMin: number; reason: OpeningConflict }[] } {
  const booked = current.filter((d) => d.booked);
  const saved = new Map(
    chair.openings.filter((o) => !o.booked).map((o) => [`${o.startMin}|${o.durationMin}`, o.id]),
  );
  const fill = fillOpenings({
    startMin: spec.startMin,
    endMin: spec.endMin,
    cutMin: spec.cutMin,
    bufferMin: view.bufferMin,
    day: chairSpans(chair, opts),
    keep: booked.map((b) => ({ start: b.startMin, end: b.startMin + b.durationMin })),
    now: view.nowMin,
  });
  const made: DraftOpening[] = fill.openings.map((o) => {
    const id = saved.get(`${o.start}|${spec.cutMin}`);
    return {
      key: id ?? newKey(),
      ...(id ? { id } : {}),
      startMin: o.start,
      durationMin: spec.cutMin,
      price: spec.price,
      booked: false,
    };
  });
  return {
    openings: [...booked, ...made].sort(byStart),
    skipped: fill.skipped.map((s) => ({ startMin: s.start, reason: s.reason })),
  };
}

/** A new opening at a tapped time - or why it can't go there. */
export function addOpening(
  view: DayView,
  chair: DayViewChair,
  current: DraftOpening[],
  opening: { startMin: number; durationMin: number; price: number },
  opts: PlaceOptions = {},
): { ok: true; openings: DraftOpening[]; key: string } | { ok: false; reason: OpeningConflict } {
  const reason = placementProblem(view, chair, current, opening, undefined, opts);
  if (reason) return { ok: false, reason };
  const key = newKey();
  return { ok: true, key, openings: [...current, { key, ...opening, booked: false }].sort(byStart) };
}

/** How many openings differ from the saved day (added, removed or re-priced). */
export function changeCount(view: DayView, draft: Draft): number {
  let n = 0;
  for (const chair of view.chairs) {
    const mine = draft[chair.staffId] ?? [];
    const saved = new Map(chair.openings.map((o) => [o.id, o]));
    const kept = new Set<string>();
    for (const d of mine) {
      if (!d.id) {
        n += 1;
        continue;
      }
      kept.add(d.id);
      const was = saved.get(d.id);
      if (!was || was.price !== d.price || was.startMin !== d.startMin || was.durationMin !== d.durationMin) n += 1;
    }
    n += chair.openings.filter((o) => !kept.has(o.id)).length;
  }
  return n;
}

/**
 * The calendar moved under the barber (409 `changed`): put his draft on top of
 * the FRESH day. Booked openings come from the fresh day, always. Each of his
 * other openings is kept where it still fits; one that no longer does (a
 * booking landed there) is dropped and reported, never saved on top of it. An
 * opening whose saved row is gone becomes a new one if it still fits.
 */
export function rebaseDraft(
  fresh: DayView,
  draft: Draft,
  opts: PlaceOptions = {},
): { draft: Draft; dropped: { staffId: string; startMin: number }[] } {
  const out: Draft = {};
  const dropped: { staffId: string; startMin: number }[] = [];
  for (const chair of fresh.chairs) {
    const savedIds = new Set(chair.openings.map((o) => o.id));
    const bookedIds = new Set(chair.openings.filter((o) => o.booked).map((o) => o.id));
    const next: DraftOpening[] = chair.openings
      .filter((o) => o.booked)
      .map((o) => ({ key: o.id, id: o.id, startMin: o.startMin, durationMin: o.durationMin, price: o.price, booked: true }));
    for (const d of draft[chair.staffId] ?? []) {
      if (d.id && bookedIds.has(d.id)) continue; // already in, as booked
      const candidate: DraftOpening = d.id && savedIds.has(d.id) ? d : { ...d, id: undefined, booked: false };
      if (placementProblem(fresh, chair, next, candidate, undefined, opts)) {
        dropped.push({ staffId: chair.staffId, startMin: d.startMin });
        continue;
      }
      next.push(candidate);
    }
    out[chair.staffId] = next.sort(byStart);
  }
  return { draft: out, dropped };
}

/** "9:00 AM" for a minute of the day. */
export function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * "2:20–3:40 PM", "10:00 AM–2:20 PM", "11:00 PM–midnight". The day's end
 * (1440) is midnight, never a second "12:00 AM" that reads like the start.
 */
export function clockRange(startMin: number, endMin: number): string {
  if (endMin >= 1440) return `${startMin <= 0 ? "midnight" : clock(startMin)}–midnight`;
  const a = clock(startMin);
  const b = clock(endMin);
  if (a.slice(-2) === b.slice(-2)) return `${a.slice(0, -3)}–${b}`;
  return `${a}–${b}`;
}

/** A span on the timeline: "all day" for a whole-day block, else its times. */
export function spanLabel(startMin: number, endMin: number): string {
  return startMin <= 0 && endMin >= 1440 ? "all day" : clockRange(startMin, endMin);
}

/**
 * "2026-11-26" -> "Thu, Nov 26". Built and printed in UTC, so the weekday is
 * the date's own whatever zone the browser (or the shop) is in - a Thanksgiving
 * never reads as a Wednesday on the West Coast or a Friday further east.
 */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Is this chair's day already shut to clients before any special opening?
 *   "off"     - he does not work that weekday;
 *   "blocked" - every minute of his hours is under blocked time;
 *   null      - clients can book at least part of his normal hours.
 */
export function closedDay(chair: Pick<DayViewChair, "hours" | "blocks">): "off" | "blocked" | null {
  if (chair.hours.length === 0) return "off";
  const blocks = [...chair.blocks].sort((a, b) => a.startMin - b.startMin);
  const covered = (s: number, e: number) => {
    let cursor = s;
    for (const b of blocks) {
      if (b.startMin > cursor) break;
      cursor = Math.max(cursor, b.endMin);
      if (cursor >= e) return true;
    }
    return cursor >= e;
  };
  return chair.hours.every((h) => covered(h.startMin, h.endMin)) ? "blocked" : null;
}

/** Short words for why a run of times was left out of a fill. */
const SKIP_WORDS: Record<OpeningConflict, string> = {
  booking: "bookings",
  blocked: "blocked off",
  past: "already passed",
  opening: "other openings",
  outside_day: "past midnight",
};

/**
 * The result of "Fill the day" in ONE short line, never a list of every slot:
 *   "Added 22 openings at $60. Skipped 2:20–3:40 PM (bookings)."
 *   "No openings added. Skipped 10:00 AM–2:20 PM and 3:40–8:00 PM (blocked off); 2:20–3:40 PM (bookings)."
 * Skipped starts one step apart (cut + turnover) with the same reason merge
 * into one range, which runs to the end of the last skipped cut.
 */
export function summarizeFill(input: {
  made: number;
  price: number;
  cutMin: number;
  bufferMin: number;
  skipped: { startMin: number; reason: OpeningConflict }[];
}): string {
  const step = input.cutMin + Math.max(0, input.bufferMin);
  const runs: { reason: OpeningConflict; start: number; lastStart: number }[] = [];
  for (const s of [...input.skipped].sort((a, b) => a.startMin - b.startMin)) {
    const last = runs[runs.length - 1];
    if (last && last.reason === s.reason && s.startMin - last.lastStart <= step) last.lastStart = s.startMin;
    else runs.push({ reason: s.reason, start: s.startMin, lastStart: s.startMin });
  }
  const order: OpeningConflict[] = [];
  for (const r of runs) if (!order.includes(r.reason)) order.push(r.reason);
  const groups = order.map((reason) => {
    const ranges = runs
      .filter((r) => r.reason === reason)
      .map((r) => clockRange(r.start, r.lastStart + input.cutMin));
    const list = ranges.length > 1 ? `${ranges.slice(0, -1).join(", ")} and ${ranges[ranges.length - 1]}` : ranges[0];
    return `${list} (${SKIP_WORDS[reason]})`;
  });
  const price = Number.isInteger(input.price) ? `$${input.price}` : `$${input.price.toFixed(2)}`;
  const head =
    input.made === 0
      ? "No openings added."
      : `Added ${input.made} opening${input.made === 1 ? "" : "s"} at ${price}.`;
  return groups.length > 0 ? `${head} Skipped ${groups.join("; ")}.` : head;
}

/** "HH:MM" <-> minutes, for <input type="time">. */
export function hhmm(min: number): string {
  const m = Math.max(0, Math.min(1439, min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export function minutesOf(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]) * 60 + Number(m[2]);
  return n >= 0 && n < 1440 ? n : null;
}
