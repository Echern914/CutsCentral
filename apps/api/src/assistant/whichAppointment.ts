import type { TurnContext } from "./guided.js";
import { clauses, matchServices, MOVE_CUE, norm, parseDates, weekdayOf } from "./guided.js";

/**
 * WHICH OF THE PERSON'S APPOINTMENTS DO THEIR WORDS MEAN?
 *
 * Every cue the person gave about an EXISTING booking points at the
 * bookings it fits - a weekday ("my wednesday appointment" = any Wednesday
 * booking, not just the next Wednesday), a date, a time, a service, a barber,
 * an explicit "next one" - and only cues that fit something count, so "move my
 * fade to friday" (a new day that fits nothing) still finds the fade.
 *
 *   one booking fits the most cues   -> that one
 *   several tie                      -> ASK, showing each one's real date, time and service
 *   no cues                          -> the earlier messages are tried; then, with several bookings, ASK
 *
 * Never the earliest by default. (Held-out multi-04: "push my wednesday appt to
 * saturday" with two Wednesday bookings silently took the first.)
 */

type Appt = TurnContext["appointments"][number];

const WEEKDAY_RE: Array<[number, RegExp]> = [
  [0, /\b(sunday|sun|domingo)\b/],
  [1, /\b(monday|mon|lunes)\b/],
  [2, /\b(tuesday|tues?|martes)\b/],
  [3, /\b(wednesday|wed|weds|miercoles)\b/],
  [4, /\b(thursday|thurs?|thu|jueves)\b/],
  [5, /\b(friday|fri|viernes)\b/],
  [6, /\b(saturday|sat|sabado)\b/],
];

/**
 * The part of a message about the EXISTING booking: in a move, what comes
 * before "to <new day>" - the first "to" AFTER the move word, not the "to" in
 * "need to reschedule" (tasks-v2: that split threw away "my beard trim").
 * And never what they said to keep ("i meant the skin fade. keep the beard trim").
 */
function oldPart(text: string): string {
  const kept = text.replace(/\b(keep|leave)\b[^.,;!?]*/gi, " ");
  const t = norm(kept);
  const verb = MOVE_CUE.exec(t);
  if (!verb) return kept;
  const m = /\s(to|into|onto|over to|para)\s/.exec(t.slice(verb.index + verb[0].length));
  if (!m) return kept;
  // Cut the RAW text at the same word, keeping its punctuation for clauses.
  const cut = verb.index + verb[0].length + m.index;
  return t.slice(0, cut + 1);
}

function cueFilters(raw: string, ctx: TurnContext): Array<(a: Appt) => boolean> {
  const t = norm(raw);
  const filters: Array<(a: Appt) => boolean> = [];
  // A weekday WITH its date ("friday the 6th") is a date, not every Friday.
  const noDated = WEEKDAY_RE.reduce((s, [, r]) => s.replace(new RegExp(`${r.source}(?= (the )?\\d)`, "g"), " "), t);
  const weekdays = WEEKDAY_RE.filter(([, r]) => r.test(noDated)).map(([d]) => d);
  if (weekdays.length) filters.push((a) => weekdays.includes(weekdayOf(a.date)));
  // Each calendar date named (10/28, oct 28, the 28th, this week) is its own
  // cue - not a weekday, which parseDates would turn into only the NEXT one.
  const stripWeekdays = (s: string) => WEEKDAY_RE.reduce((x, [, r]) => x.replace(new RegExp(r.source, "g"), " "), s);
  const seen = new Set<string>();
  for (const c of clauses(raw)) {
    const d = parseDates(stripWeekdays(c), ctx.today);
    if (!d || seen.has(`${d.from}|${d.to}`)) continue;
    seen.add(`${d.from}|${d.to}`);
    filters.push((a) => a.date >= d.from && a.date <= d.to);
  }
  const services = matchServices(t, ctx.services);
  if (services.length) filters.push((a) => services.some((s) => (a.service ?? a.label).toLowerCase().includes(s.toLowerCase())));
  const barbers = ctx.barbers.filter((b) => new RegExp(`\\b${b.toLowerCase().split(" ")[0]}\\b`).test(t));
  if (barbers.length) filters.push((a) => barbers.some((b) => (a.staff ?? a.label).toLowerCase().includes(b.toLowerCase())));
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/.exec(t);
  if (time) {
    let h = Number(time[1] ?? time[4]);
    const min = Number(time[2] ?? time[5] ?? 0);
    const ap = time[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h < 8) h += 12; // "2:30" at a shop means the afternoon
    filters.push((a) => a.minutes === undefined || a.minutes === h * 60 + min);
  }
  if (/\b(morning)\b/.test(t)) filters.push((a) => a.minutes === undefined || a.minutes < 12 * 60);
  if (/\b(afternoon|evening)\b/.test(t)) filters.push((a) => a.minutes === undefined || a.minutes >= 12 * 60);
  return filters;
}

/**
 * The bookings that fit the MOST live cues. Strict "fits every cue" emptied
 * the list whenever one cue was about something else ("my 4pm friday thing,
 * can it be earlier ... in the morning" - morning is the NEW time).
 */
function narrow(raw: string, ctx: TurnContext): Appt[] | null {
  const live = cueFilters(raw, ctx).filter((f) => ctx.appointments.some(f));
  if (live.length === 0) return null;
  const scored = ctx.appointments.map((a) => ({ a, n: live.filter((f) => f(a)).length }));
  const best = Math.max(...scored.map((s) => s.n));
  return scored.filter((s) => s.n === best).map((s) => s.a);
}

export function whichAppointment(
  _intent: "cancel" | "move",
  text: string,
  ctx: TurnContext,
  recent: string[] = [],
): { refs: string[] } {
  const all = ctx.appointments;
  if (all.length <= 1) return { refs: all.map((a) => a.ref) };
  const part = oldPart(text);
  const p = norm(part);
  // An explicit order is an answer, not a default: "my next appointment".
  if (/\b(next|earliest|soonest|first) (one|appointment|appt|booking|cut)\b/.test(p)) return { refs: [all[0]!.ref] };
  if (/\b(last|latest|later) (one|appointment|appt|booking)\b/.test(p)) return { refs: [all[all.length - 1]!.ref] };
  const now = narrow(part, ctx);
  if (now && now.length === 1) return { refs: [now[0]!.ref] };
  // Still several: the person's earlier messages may settle it ("cancel
  // wednesday" ... "the one this week" = the Wednesday this week). Nothing in
  // THIS message at all: the earlier messages decide on their own.
  for (const r of [...recent].reverse()) {
    const before = narrow(oldPart(r), ctx);
    if (!before || !before.length) continue;
    const both = now ? before.filter((a) => now.includes(a)) : before;
    if (both.length === 1) return { refs: [both[0]!.ref] };
    if (!now) return { refs: before.map((a) => a.ref) };
  }
  return { refs: (now ?? all).map((a) => a.ref) };
}
