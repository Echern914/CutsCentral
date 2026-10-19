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

/** What is on a chair, as minute spans, for the shared placement rule. */
export function chairSpans(chair: DayViewChair) {
  const span = (i: { startMin: number; endMin: number }): Span => ({ start: i.startMin, end: i.endMin });
  return { bookings: chair.bookings.map(span), external: chair.external.map(span), blocks: chair.blocks.map(span) };
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
): OpeningConflict | null {
  return openingConflict({ start: opening.startMin, end: opening.startMin + opening.durationMin }, chairSpans(chair), {
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
    day: chairSpans(chair),
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
): { ok: true; openings: DraftOpening[]; key: string } | { ok: false; reason: OpeningConflict } {
  const reason = placementProblem(view, chair, current, opening);
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
export function rebaseDraft(fresh: DayView, draft: Draft): { draft: Draft; dropped: { staffId: string; startMin: number }[] } {
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
      if (placementProblem(fresh, chair, next, candidate)) {
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
