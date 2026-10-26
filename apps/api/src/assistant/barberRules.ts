import { matchService, norm, parseDates } from "./guided.js";

/**
 * THE BARBER CHAT'S TYPED SHORTCUTS - server rules, no model.
 *
 * Typed words only ever pick WHERE the chat goes next (a day to show, a client
 * to look up, an appointment to point at). They never choose a time to book or
 * confirm anything: every change is still a button the server drew, then a
 * preview, then Confirm. Anything these rules don't recognise returns null,
 * and the bubble answers it as a help question instead.
 */
export type BarberIntent =
  | { kind: "day"; date: string | null }
  | { kind: "book"; name: string | null; service: string | null; date: string | null }
  | { kind: "move" | "cancel"; name: string | null; date: string | null; minutes: number | null };

const BOOK_CUE = /^\s*(?:please\s+)?(?:book|add|put)\b/;
const MOVE_CUE = /\b(?:move|reschedule|push)\b/;
const CANCEL_CUE = /\b(?:cancel|call off)\b/;
const DAY_CUE =
  /\b(?:my day|my schedule|my agenda|my calendar|my appointments|my bookings|who(?:'s| is)? (?:next|first|up|coming|booked|on)|what(?:'s| is| do i have)(?: on)? (?:today|tomorrow|tonight|my)|how many (?:appointments|bookings|clients|people)|today|tomorrow|tonight)\b/;
/**
 * 🔴 A HOW-TO QUESTION IS A HELP QUESTION. "How do I cancel an appointment?"
 * must get the help answer, not start cancelling one - so a question shaped
 * like that only reaches these rules when it names the barber's own day.
 */
const HELP_QUESTION = /^\s*(?:how|why|where|when can|can (?:i|my|clients?|customers?|people)|could i|what does|what's an?|what is an?|do i|does|is there|are there|should|help|i need help)\b/;
const NAMES_A_DAY = /\b(?:today|tomorrow|tonight|my day|this week)\b/;

/** Words that are never part of a client's name in these sentences. */
const FILLER = new Set(
  (
    "a an the for with on at to my me i in from of it its is am pm appointment appt booking visit cut time slot " +
    "please can you could would book add schedule put move reschedule push switch change cancel call off drop " +
    "today tomorrow tonight morning afternoon evening next this week weekend instead earlier later new client " +
    "mon monday tue tues tuesday wed weds wednesday thu thur thurs thursday fri friday sat saturday sun sunday " +
    "jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october " +
    "nov november dec december"
  ).split(" "),
);

/** "3", "3pm", "3:30 pm", "15:30" -> minutes after midnight, when a time is named. */
export function timeOfDay(text: string): number | null {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (!ap && !m[2]) return null; // a bare "3" is a date or a count, not a time
  if (h > 23 || min > 59) return null;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  // "at 3" with minutes but no am/pm: a barber's day runs 7am-9pm.
  if (!ap && h >= 1 && h <= 6) h += 12;
  return h * 60 + min;
}

/** What is left once cue words, services, dates and times are removed: a name to look up. */
export function nameIn(text: string, services: string[]): string | null {
  let t = norm(text).replace(/'s\b/g, "");
  for (const s of services) t = t.replace(new RegExp(`\\b${norm(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  const words = t
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?\b/g, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/g, " ")
    .split(/[^a-z'-]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
  return words.length ? words.slice(0, 3).join(" ") : null;
}

/** The single day a message names, when it names one. */
function oneDay(text: string, today: string): string | null {
  const r = parseDates(text, today);
  return r && r.from === r.to ? r.from : r?.from ?? null;
}

export function barberIntent(text: string, ctx: { today: string; services: string[] }): BarberIntent | null {
  const t = norm(text);
  if (!t.trim()) return null;
  if (HELP_QUESTION.test(t) && !NAMES_A_DAY.test(t)) return null;
  const date = oneDay(t, ctx.today);
  if (CANCEL_CUE.test(t)) return { kind: "cancel", name: nameIn(t, ctx.services), date, minutes: timeOfDay(t) };
  if (MOVE_CUE.test(t)) return { kind: "move", name: nameIn(t, ctx.services), date, minutes: timeOfDay(t) };
  if (BOOK_CUE.test(t)) return { kind: "book", name: nameIn(t, ctx.services), service: matchService(t, ctx.services), date };
  if (DAY_CUE.test(t)) return { kind: "day", date };
  // A bare day ("friday", "oct 30") is a request to see it.
  if (date && t.split(" ").length <= 3) return { kind: "day", date };
  return null;
}
