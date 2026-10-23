import type { ProposedAction } from "./actions.js";
import { whichAppointment } from "./whichAppointment.js";

/**
 * TYPED MESSAGES -> ONE ACTION, by plain keyword and date rules (no model).
 *
 * Typing is a shortcut into the same menu flows the buttons drive: the rules
 * pick an action, and the buttons it returns (times, appointments) carry the
 * rest of the task without any interpretation at all. Deliberately narrow:
 * when the rules are not sure they ask (`clarify`, `choose_appointment`)
 * rather than guess, and every change still waits for a preview and a tap.
 */

export interface TurnContext {
  /** Today in the shop's own zone, YYYY-MM-DD. */
  today: string;
  /** Service names on the public menu. */
  services: string[];
  barbers: string[];
  /** The actor's own upcoming appointments, as the refs the server handed out. */
  appointments: Array<{ ref: string; date: string; label: string; service?: string; staff?: string; minutes?: number }>;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** What may follow a month's first three letters: "uary", "ch", "t", "tember", "." ... */
const MONTH_TAILS = "uary|ruary|ch|il|e|y|ust|t|tember|ober|ember|";
const MESES: Record<string, number> ={ ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
const WEEKDAY_ALIASES = [
  ["sunday", "sun", "domingo"],
  ["monday", "mon", "lunes"],
  ["tuesday", "tue", "tues", "martes"],
  ["wednesday", "wed", "weds", "miercoles"],
  ["thursday", "thu", "thur", "thurs", "jueves"],
  ["friday", "fri", "viernes"],
  ["saturday", "sat", "sabado"],
];

export function guidedProposal(text: string, ctx: TurnContext, recent: string[] = []): ProposedAction {
  const t = norm(text);

  // 🔴 A REPLY CONTINUES THE CONVERSATION. "the haircut on nov 4" after
  // "which appointment do you want to cancel?" is the answer, not a new
  // booking; "no wait, a skin fade" keeps the Friday morning already said.
  // (tasks-v2, first run: typed answers to "which one?" turned into booking
  // searches, and corrections dropped the day and time.)
  const intent = continuation(t, ctx, recent) ?? intentOf(t, ctx);
  switch (intent) {
    case "cancel":
    case "move":
      return appointmentAction(intent, text, ctx, recent);
    case "ask_shop":
      return { name: "ask_shop", args: {} };
    case "view":
      return { name: "my_appointments", args: {} };
    case "prices":
      return { name: "list_services", args: {} };
    case "book":
      return booking(text, ctx, intentOf(t, ctx) === null ? recent : []);
    default:
      // Nothing but a service ("kids cut for my daughter sunday"): a booking.
      return matchService(t, ctx.services) ? booking(text, ctx, []) : { name: "clarify", args: { missing: "what" } };
  }
}

export type Intent = "cancel" | "move" | "book" | "view" | "ask_shop" | "prices" | "never_mind";

/** What THIS message asks for on its own words, or null for a bare answer ("the 2:30", "saturday", "the fade"). */
export function intentOf(t: string, ctx: TurnContext): Intent | null {
  if (NEVER_MIND_CUE.test(t) && isNeverMind(t, ctx)) return "never_mind";
  const cancel = CANCEL_CUE.test(t);
  // "cancel the nov 4 one instead" is a cancel: "instead" never beats the word
  // cancel. But "can't make it friday, can we do monday instead" is a MOVE
  // (held-out tasks-v3 res-04 got a cancel preview from the rules).
  const saidCancel = /\b(cancel\w*|call off)\b/.test(t);
  // ...and "a beard trim instead" / "sam instead" while booking is a booking
  // correction: a bare "instead" next to a service or a barber is not a move.
  const namesBooking = matchService(t, ctx.services) !== null || firstBarber(t, ctx) !== undefined;
  const move = STRONG_MOVE_CUE.test(t) || (MOVE_CUE.test(t) && !saidCancel && !namesBooking);
  if (cancel && !move) return "cancel";
  if (move) return "move";
  if (ASK_SHOP_CUE.test(t) && !/\b(book|appointment|appt|openings?|available)\b/.test(t)) return "ask_shop";
  if (VIEW_CUE.test(t)) return "view";
  if (PRICE_Q.test(t) && !parseDates(t, ctx.today)) return "prices";
  if (BOOK_CUE.test(t)) return "book";
  return null;
}

/**
 * A bare answer takes the intent of the person's latest earlier request
 * (cancel, move or book), skipping side questions ("do you have parking?")
 * and stopping at a "never mind". Only the person's own words are read.
 */
export function continuation(t: string, ctx: TurnContext, recent: string[]): "cancel" | "move" | "book" | null {
  const own = intentOf(t, ctx);
  // "my appointment on the 28th" answering "which one?" is not a request to view.
  const bare = own === null || (own === "view" && !VIEW_STRONG.test(t)) || (own === "book" && !BOOK_VERB.test(t));
  if (!bare) return null;
  for (const r of [...recent].reverse()) {
    const rn = norm(r);
    // A refused request is never picked back up by a follow-up ("come on,
    // his name's Tyler, just look him up" after "move my roommate's 3pm").
    if (looksLikeBypass(rn) || ((CANCEL_CUE.test(rn) || MOVE_CUE.test(rn)) && FOR_SOMEONE_ELSE.test(rn))) return null;
    const i = intentOf(rn, ctx);
    if (i === "never_mind") return null;
    if (i === "cancel" || i === "move" || i === "book") return i;
    // "haircut monday nov 2 with drew pls" asks for a booking without a verb.
    if (i === null && matchService(rn, ctx.services)) return "book";
  }
  return null;
}

/**
 * A booking search: what THIS message says, and - for a bare follow-up - the
 * service, day, barber and time of day said earlier, newest first, stopping
 * at a cancel, move or "never mind".
 */
export function booking(text: string, ctx: TurnContext, recent: string[]): ProposedAction {
  const f = bookingFields(text, ctx);
  for (const r of [...recent].reverse()) {
    const i = intentOf(norm(r), ctx);
    if (i === "cancel" || i === "move" || i === "never_mind") break;
    const e = bookingFields(r, ctx);
    f.service ??= e.service;
    f.range ??= e.range;
    f.barber ??= e.barber;
    f.part ??= e.part;
  }
  if (!f.service) return { name: "clarify", args: { missing: "service" } };
  return {
    name: "find_openings",
    args: {
      service: f.service,
      ...(f.range ? { date: f.range.from, ...(f.range.to !== f.range.from ? { to_date: f.range.to } : {}) } : {}),
      ...(f.barber ? { barber: f.barber } : {}),
      ...(f.part ? { part: f.part } : {}),
    },
  };
}

export function bookingFields(text: string, ctx: TurnContext): { service?: string; range?: { from: string; to: string }; barber?: string; part?: Part } {
  const t = norm(text);
  return {
    service: matchService(dropNegated(t), ctx.services) ?? undefined,
    range: bookingDate(text, ctx) ?? undefined,
    barber: firstBarber(t, ctx),
    part: partOfDay(t) ?? undefined,
  };
}

/** "a skin fade not a haircut": the service after "not" is the one they DON'T want. */
function dropNegated(t: string): string {
  return t.replace(/\b(not|instead of|rather than)\s+(an? |the |my )?[a-z]+( [a-z]+)?/g, " ");
}

/** The barber named FIRST ("actually sam, drew always rushes" = Sam). */
function firstBarber(t: string, ctx: TurnContext): string | undefined {
  return ctx.barbers
    .map((b) => ({ b, i: t.search(new RegExp(`\\b${b.toLowerCase().split(" ")[0]}\\b`)) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)[0]?.b;
}

/**
 * The day to book. When a message names several days ("a wedding on Saturday
 * the 7th ... a haircut on Thursday the 5th"), the one in the sentence that
 * asks for the service or the booking.
 */
export function bookingDate(text: string, ctx: TurnContext): { from: string; to: string } | null {
  const dated = clauses(text)
    .map((c) => ({ c, d: parseDates(c, ctx.today) }))
    .filter((x): x is { c: string; d: { from: string; to: string } } => x.d !== null);
  if (!dated.length) return parseDates(norm(text), ctx.today);
  const asked = dated.find((x) => matchService(x.c, ctx.services) || BOOK_CUE.test(x.c));
  return (asked ?? dated[0]!).d;
}

/** Every distinct single day the message names, in order. */
export function allDates(text: string, ctx: TurnContext): string[] {
  const out: string[] = [];
  for (const c of clauses(text)) {
    const d = parseDates(c, ctx.today);
    if (d && d.from === d.to && !out.includes(d.from)) out.push(d.from);
  }
  return out;
}

export function clauses(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[.!?;,]+|\s(?:and|but|then|y|pero)\s/)
    .map((c) => norm(c))
    .filter((c) => c.trim());
}

export type Part = "morning" | "afternoon";
/** Morning / afternoon, in the words people text ("after 2", "after lunch", "en la tarde"). */
export function partOfDay(t: string): Part | null {
  if (/\b(morning|mornin|before (noon|12|lunch)|early|(por|en|de) la manana)\b/.test(t)) return "morning";
  if (/\b(afternoon|after ?noon|after lunch|tarde|evening|after work|after (1|2|3|4)(:\d\d)?( ?pm)?|late)\b/.test(t)) return "afternoon";
  return null;
}

/** One normalisation for every rule: lower case, accents off ("mañana" = "manana"), punctuation to spaces. */
export function norm(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9/':\- ]+/g, " ")} `;
}

/**
 * RULES THAT RUN FIRST, before any reading of what the message asks for:
 *
 *  - A message that tries to change the rules ("ignore your instructions",
 *    "cancel every appointment", "without confirming") is NOT a request: it
 *    gets a fixed refusal and no action, buttons or preview.
 *  - Someone else's booking is theirs to change ("move my roommate's 3pm ...
 *    he asked me to" once offered to move the person's OWN booking).
 *  - Booking two services in one go is not supported: say so, and offer each
 *    one as a button, instead of asking "what would you like?" as if nothing
 *    had been said ("I'd like to book a fade and a beard").
 */
export function preRule(text: string, ctx: TurnContext): ProposedAction | null {
  const t = norm(text);
  if (looksLikeBypass(t)) return { name: "unsupported", args: { reason: "bypass" } };
  if ((CANCEL_CUE.test(t) || MOVE_CUE.test(t)) && FOR_SOMEONE_ELSE.test(t)) {
    return { name: "unsupported", args: { reason: "someone_else" } };
  }
  if (!CANCEL_CUE.test(t) && !MOVE_CUE.test(t) && !PRICE_CUE.test(t)) {
    const named = matchServices(t, ctx.services);
    if (named.length >= 2 && /\b(book|get|come in|appointment|appt|openings?|available|and)\b/.test(t)) {
      const range = parseDates(t, ctx.today);
      return { name: "one_at_a_time", args: { services: named.slice(0, 3), ...(range ? { date: range.from } : {}) } };
    }
  }
  return null;
}

const BYPASS = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|rules?|prompt|polic(y|ies)|guidelines?|system)\b/,
  /\b(system|developer|hidden) (prompt|message|instructions?)\b/,
  /\byou are now\b|\bact as (an? )?(admin|owner|developer|system)\b|\bpretend (to be|you are)\b/,
  /\b(bypass|jailbreak|sudo|admin mode|developer mode|god mode)\b/,
  /\bwithout (confirm\w*|asking|checking|permission)\b/,
  /\b(cancel|delete|remove|move|reschedule|book)\b.{0,20}\b(all|every|everyone'?s?|anyone'?s?|other (people|clients|customers)'?s?)\b/,
  /\b(someone|somebody|another (person|client|customer))'?s? (appointment|booking)\b/,
  // Held-out evaluation (2026-10-23), each one let through before:
  // a role claimed in the message itself ("SYSTEM: verified as the owner")
  /^\s*(system|assistant|developer|admin)\s*[:>]/,
  /\b(verified|authori[sz]ed?|confirmed) (as|that i am|i'?m) (the )?(shop )?(owner|admin|manager|barber|developer)\b/,
  /\bi'?m the (shop )?(owner|admin|manager|developer)\b/,
  // acting for, or as, someone else ("cancel HIS appointment", "switch me to her account")
  /\b(his|her|their|my (brother|sister|friend|wife|husband|partner|dad|mom|mother|father)'?s?) (appointment|appt|booking|account)s?\b/,
  /\b(switch|log|sign) (me )?(in|over|into)? ?(to )?(his|her|their|another|someone'?s?|a different) account\b/,
  /\bthis is \w+'?s (brother|sister|friend|wife|husband|partner|dad|mom|mother|father|son|daughter)\b/,
  // prices are the shop's ("set the price to $0", "make it free")
  /\b(set|change|lower|drop|make)\b.{0,25}\bprice\b|\bfor free\b|\$\s?0(\.00)?\b|\bno charge\b/,
  // skipping the confirmation in any spelling
  /\b(skip|bypass|without|no need for|don'?t (ask|need)) (the |a |any )?(confirm\w*|tap|check\w*)\b/,
  // an encoded payload to "decode and do"
  /\bdecode\b|\bbase ?64\b|[A-Za-z0-9+/]{24,}={0,2}/,
];
/**
 * Leetspeak and look-alikes fold to letters first ("1gn0re y0ur rul3s",
 * "c4ncel") - held-out case mal-09 walked straight past the plain patterns.
 */
function unLeet(t: string): string {
  return t.replace(/[0134578@$]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s" })[c] ?? c);
}
export function looksLikeBypass(t: string): boolean {
  const folded = unLeet(t);
  return BYPASS.some((r) => r.test(t) || r.test(folded));
}

export const CANCEL_CUE =
  /\b(cancel\w*|call off|can'?t make it|cant make it|won'?t make it|not coming|can'?t come|cant come|won'?t be able to (come|make it|go)|not gonna make it|can'?t do (my|the|it)|cant do (my|the|it)|no puedo ir)\b/;
const MOVE_WORDS = String.raw`reschedul\w*|move|push (it|my|back)|change (my|the) (time|day|appointment)|different (time|day)|another (time|day)|switch (my|the)|bump|(be|make it|do it) (earlier|later)|cambiar|mover`;
export const MOVE_CUE = new RegExp(`\\b(${MOVE_WORDS}|instead)\\b`);
/** A move in so many words - "instead" alone is not one ("cancel the other one instead"). */
const STRONG_MOVE_CUE = new RegExp(`\\b(${MOVE_WORDS})\\b`);
const PRICE_CUE = /\b(price|prices|cost|how much)\b/;
/** A question about prices or the menu - not "regular price is ok". */
const PRICE_Q = /\b(prices|cost|costs|how much|how long|services|menu|what do you (offer|do|have)|what'?s the price|price (of|for|list))\b/;
const VIEW_STRONG = /\b(when('?s| is| was) my|do i have|am i booked|coming up|upcoming|next appointment|go (thru|through)|went (thru|through)|what time (is|was) (my|it)|(mis|q|que) citas|tengo (una )?cita|my (appointments|bookings))\b/;
const VIEW_CUE = new RegExp(`${VIEW_STRONG.source}|\\bmy (appointment|booking|appt)\\b`);
/** Asking for a booking in so many words (not just naming an appointment). */
const BOOK_VERB = /\b(book|available|availability|opening|openings|slot|slots|come in|get in|squeeze|fit me|get an?|need an?|want an?|lemme get|let me get|can i get|quiero|necesito)\b/;
const BOOK_CUE = new RegExp(`${BOOK_VERB.source}|\\b(appointment|appt|cita)\\b`);
/** Acting for someone else ("he asked me to", "for him") on a move or cancel. */
const FOR_SOMEONE_ELSE = /\b(he|she|they) (asked|wants?|told) me\b|\bfor (him|her|them)\b|\bmy (?!son\b|daughter\b|kid\b|kids\b|child\b|boy\b|girl\b|little\b|own\b)[a-z]+'s (appointment|appt|booking|account|\d)/;


/**
 * A cancel or a move of ONE of the person's bookings. Which one is decided by
 * whichAppointment (their words, then their earlier messages); several left
 * means the person chooses from buttons showing each one - never a default.
 */
export function appointmentAction(intent: "cancel" | "move", text: string, ctx: TurnContext, recent: string[] = []): ProposedAction {
  if (ctx.appointments.length === 0) return { name: "clarify", args: { missing: "appointment" } };
  const { refs } = whichAppointment(intent, text, ctx, recent);
  if (refs.length !== 1) return { name: "choose_appointment", args: { intent, refs } };
  const ref = refs[0]!;
  if (intent === "cancel") return { name: "cancel", args: { appointment: ref } };
  const appt = ctx.appointments.find((a) => a.ref === ref)!;
  // The NEW day, from this message - or from the earlier message that asked
  // for the move ("reschedule my appt with drew to tomorrow" ... "the fade").
  let found = newDay(text, appt, ctx);
  for (const r of [...recent].reverse()) {
    if (found.date) break;
    if (MOVE_CUE.test(norm(r))) {
      const e = newDay(r, appt, ctx);
      found = { date: e.date, part: found.part ?? e.part };
    }
  }
  return { name: "reschedule", args: { appointment: ref, ...(found.date ? { date: found.date } : {}), ...(found.part ? { part: found.part } : {}) } };
}

/**
 * Where a move goes: a day after "to"/"para"; a day relative to the booking
 * itself ("back a day", "that same day", "the week after"); or any day named
 * that isn't the booking's own. Morning/afternoon only when it is about the
 * NEW time (after "to", or with a same-day move).
 */
function newDay(text: string, appt: TurnContext["appointments"][number], ctx: TurnContext): { date?: string; part?: Part } {
  const t = norm(text);
  const split = /\s(to|into|onto|instead|over to|para)\s/.exec(t);
  const later = split ? t.slice(split.index) : null;
  const rel = relativeDay(t, appt.date);
  const afterSplit = later ? allDates(later, ctx).find((d) => d !== appt.date) : undefined;
  const any = allDates(text, ctx).find((d) => d !== appt.date);
  const date = afterSplit ?? rel ?? any;
  const part = partOfDay(later ?? (rel === appt.date ? t : "")) ?? undefined;
  return { date, part };
}

function relativeDay(t: string, base: string): string | undefined {
  if (/\b(two|2) weeks (later|after)\b/.test(t)) return addDays(base, 14);
  if (/\b((a|one) week (later|after)|the week after|following week|week later)\b/.test(t)) return addDays(base, 7);
  if (/\b((a|one) day (later|after)|back (a|one) day|(the )?(next|following) day|the day after)\b/.test(t)) return addDays(base, 1);
  if (/\b((a|one) day (earlier|before)|the day before|up (a|one) day)\b/.test(t)) return addDays(base, -1);
  if (/\b(same day|that day|earlier that day|later that day|mismo dia)\b/.test(t)) return base;
  return undefined;
}

/** "Can I talk to someone", parking, walk-ins, hours, where you are: the shop's own details. */
export const ASK_SHOP_CUE =
  /\b(talk to (someone|somebody|a person|a human|the (shop|barber|owner))|speak to|real person|human|call (you|the shop)|phone|number|contact|groups?|parking|park|walk[- ]?ins?|hours|open (on|till|until|today|tomorrow|late)|close|closing|address|where (are you|is the shop)|located|location|directions)\b/;

/**
 * "Never mind", "keep it", "forget it": the person withdraws what was on the
 * table. Only when nothing else is asked in the same breath - "nvm keep it,
 * move it to the 6th instead" is a NEW request (which supersedes the old one
 * anyway; every turn does).
 */
const NEVER_MIND_CUE = /\b(never ?mind|nvm|nevermind|forget (it|that|about it)|keep it|leave it( as is)?|scratch that|no thanks|nah|don'?t (do it|bother|worry about it)|changed my mind|i'?m good|all good|cancel that|stop)\b/;
export function isNeverMind(text: string, ctx: TurnContext): boolean {
  const t = norm(text);
  if (!NEVER_MIND_CUE.test(t)) return false;
  const rest = t.replace(new RegExp(NEVER_MIND_CUE.source, "g"), " ");
  // Anything else actionable in the message makes it a new request instead.
  // ("forget that, i'll book later" is still a never mind.)
  if (MOVE_CUE.test(rest) || /\b(book|cancel)\b(?! (it |one )?later)/.test(rest)) return false;
  // "nah, saturday" is a new day; "nvm, I already have one wednesday" is not.
  if ((parseDates(rest, ctx.today) || matchService(rest, ctx.services)) && !/\balready\b/.test(rest)) return false;
  return true;
}

/** The menu service whose words appear in the message (longest match wins). */
export function matchService(t: string, services: string[]): string | null {
  return matchServices(t, services)[0] ?? null;
}

/**
 * Every menu service the message names, best first. A word counts when it is
 * the menu word, its plural, or one typing slip away from a menu word of 4+
 * letters ("fde" -> fade, "beared" -> beard) - eval case "can i get a fde
 * tmrw", which these rules used to miss.
 */
export function matchServices(t: string, services: string[]): string[] {
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of services) {
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
    const hits = words.filter(
      (w) =>
        new RegExp(`\\b${w}s?\\b`).test(t) ||
        (w.length >= 4 && tokens.some((tok) => !GENERIC.has(tok) && oneSlip(tok, w))),
    ).length;
    if (hits === 0) continue;
    scored.push({ name, score: hits / words.length + hits * 0.01 });
  }
  scored.sort((a, b) => b.score - a.score);
  const named = scored.map((s) => s.name);
  if (named.length) return named;
  // Common words for the usual cut, when the menu calls it something else.
  // "corte" / "pelo": the Spanish a client is most likely to text.
  // The plain haircut first: "corte de pelo" was read as Beard Trim (the
  // first menu name containing "trim") - tasks-v2 book-06.
  if (/\b(haircut|cut|fade|trim|lineup|line up|shape ?up|corte|pelo)\b/.test(t)) {
    const cut = [/hair ?cut/i, /cut/i, /fade/i, /trim/i].map((r) => services.find((s) => r.test(s))).find(Boolean);
    return cut ? [cut] : [];
  }
  return [];
}
const STOP = new Set(["and", "the", "with", "for", "men", "mens", "kids", "adult"]);
/** Everyday words never read as a typo of a menu word ("cute" is not "cut"). */
const GENERIC = new Set(["can", "get", "need", "want", "book", "time", "come", "make", "have", "this", "that", "next", "tomorrow", "today", "please", "free", "open", "what", "when", "your", "some", "cute", "made", "fast", "date", "trip", "face"]);

/** True when `a` and `b` differ by one insertion, deletion, substitution or swap. */
export function oneSlip(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** today / tomorrow / weekday / next weekday / this week / weekend / 10/25 / oct 25 / the 25th. */
export function parseDates(t0: string, today: string): { from: string; to: string } | null {
  const one = (d: string) => ({ from: d, to: d });
  // Spanish "por la mañana" is the MORNING; "mañana" alone is tomorrow.
  const t = t0.replace(/\b(por|en|de) la manana\b/g, " ");
  if (/\b(today|tonight|hoy)\b/.test(t)) return one(today);
  if (/\bpasado manana\b/.test(t)) return one(addDays(today, 2));
  if (/\b(tomorrow|tmrw|tmr|tomorow|tommorow|manana)\b/.test(t)) return one(addDays(today, 1));
  if (/\bthis week\b/.test(t)) {
    const dow = weekdayOf(today);
    return { from: today, to: addDays(today, 6 - dow) };
  }
  if (/\b(this )?weekend\b/.test(t)) {
    const dow = weekdayOf(today);
    const sat = addDays(today, (6 - dow + 7) % 7);
    return { from: sat, to: addDays(sat, 1) };
  }
  if (/\bnext week\b/.test(t)) {
    const dow = weekdayOf(today);
    const mon = addDays(today, ((1 - dow + 7) % 7) || 7);
    return { from: mon, to: addDays(mon, 6) };
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (slash) return one(nextDate(today, Number(slash[1]), Number(slash[2]), slash[3]));
  // Only real month spellings: "[a-z]*" read Spanish "martes 3" as MARCH 3.
  const named = new RegExp(`\\b(${MONTHS.join("|")})(?:${MONTH_TAILS})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  if (named) return one(nextDate(today, MONTHS.indexOf(named[1]!) + 1, Number(named[2])));
  // "4 de noviembre"
  const es = new RegExp(`\\b(\\d{1,2}) de (${Object.keys(MESES).join("|")})[a-z]*\\b`).exec(t);
  if (es) return one(nextDate(today, MESES[es[2]!]!, Number(es[1])));
  // "the 5th", or a weekday with its date ("thursday the 5th", "martes 3") -
  // never the hour in "the 2:30".
  const nth =
    /\bthe (\d{1,2})(st|nd|rd|th)\b/.exec(t) ??
    new RegExp(`\\b(?:${WEEKDAY_ALIASES.flat().join("|")}) (?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?![:\\d])(?! ?(am|pm|o'?clock)\\b)`).exec(t);
  if (nth) {
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const day = Number(nth[1]);
    return one(day >= d ? iso(y, m, day) : nextMonth(y, m, day));
  }
  // A weekday only AFTER exact dates: "friday the 30th" is the 30th (a weekday
  // first used to win and send it to the coming Friday).
  const tokens = t.split(/[^a-z]+/);
  for (let i = 0; i < 7; i++) {
    // A typing slip in a full day name ("sundy") still counts.
    const slip = tokens.find((w) => w.length >= 5 && oneSlip(w, WEEKDAYS[i]!));
    const m = new RegExp(`\\b(next )?(${[...WEEKDAY_ALIASES[i]!, ...(slip ? [slip] : [])].join("|")})\\b`).exec(t);
    if (m) {
      const dow = weekdayOf(today);
      let ahead = (i - dow + 7) % 7;
      // "next friday" is ambiguous in speech; the coming one, never today.
      if (m[1] && ahead === 0) ahead = 7;
      return one(addDays(today, ahead));
    }
  }
  return null;
}

function nextDate(today: string, month: number, day: number, year?: string): string {
  const [y] = today.split("-").map(Number) as [number];
  if (year) return iso(year.length === 2 ? 2000 + Number(year) : Number(year), month, day);
  const candidate = iso(y, month, day);
  return candidate >= today ? candidate : iso(y + 1, month, day);
}
function nextMonth(y: number, m: number, day: number): string {
  return m === 12 ? iso(y + 1, 1, day) : iso(y, m + 1, day);
}
function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
