import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { runConfirm, runTurn, type AssistantActor, type NavKey, type TurnReply } from "./turn.js";

/**
 * TASK EVALUATION: the booking chat, run on a frozen task set, two ways:
 *
 *   buttons  the menu and its buttons only - no typing
 *   rules    each scripted message typed, then the buttons offered
 *
 * Skipped unless ASSISTANT_TASKS=1. ASSISTANT_TASKS_FILE is the frozen set
 * (its sha256 is recorded in the output), ASSISTANT_TASKS_CONFIG picks the
 * configuration, ASSISTANT_TASKS_OUT is where the JSON goes.
 *
 * 🔴 THE SIMULATED CUSTOMER SEES ONLY THE SCREEN. Every decision is made from
 * what the chat page renders - the reply text, the button labels, the preview
 * sentence - parsed the way a person reads them, plus what that person
 * already knows (their goal, today's date, their own bookings as they
 * remember them, the shop's menu prices). It never decodes a button, never
 * reads a confirmation row, never looks at the database while deciding.
 *
 *   - It taps a button only if its LABEL serves the goal.
 *   - It confirms a preview only if every figure in the SENTENCE is what it
 *     wanted: shop, service, barber, day, time, time zone and price.
 *   - Otherwise it falls back to the menu (counted separately: the chat
 *     failing, the menu rescuing it).
 *
 * 🔴 THEN THE DATABASE IS THE JUDGE. A task is complete only if the saved
 * state matches the goal; and every booking or move confirmed is checked
 * figure by figure against the sentence that was confirmed (a mismatch is the
 * worst failure this harness can report). Stale previews are tapped after the
 * conversation moved on (each must change nothing) and every Confirm used is
 * tapped twice (none may write twice).
 */

const RUN = process.env.ASSISTANT_TASKS === "1";
const CONFIG = (process.env.ASSISTANT_TASKS_CONFIG ?? "rules") as "buttons" | "rules";
const FILE = process.env.ASSISTANT_TASKS_FILE ?? "";
const SHOP_NAME = "Fixture Cuts";

type Ref = "A1" | "A2" | "A3";
type Goal =
  | { type: "book"; service: string; date: string; barber?: string; timeOfDay?: "morning" | "afternoon" }
  | { type: "reschedule"; appointment: Ref; toDate: string }
  | { type: "cancel"; appointment: Ref }
  | { type: "view" }
  | { type: "ask_shop" }
  | { type: "none" };
interface Task {
  id: string;
  category: string;
  goal: Goal;
  turns: Array<{ say: string; expect: "act" | "ask" }>;
}

let app: Express;
let shopId = "";
let TZ = "America/Los_Angeles";
let NOW = new Date();
const staff: Record<string, string> = {};
const svc: Record<string, string> = {};
const PRICE: Record<string, number> = {};
const ownerEmail = `tasks-${randomToken(6)}@test.local`.toLowerCase();

// The fixture the task sets were written against (their own header says so).
const FIXTURE: Record<Ref, { at: string; service: string; barber: string }> = {
  A1: { at: "2026-10-28T21:30:00Z", service: "Skin Fade", barber: "Drew" },
  A2: { at: "2026-11-04T18:00:00Z", service: "Haircut", barber: "Sam" },
  A3: { at: "2026-10-30T23:00:00Z", service: "Beard Trim", barber: "Drew" },
};
// Other people's bookings, which the malicious tasks reach for. Never touched.
const OTHERS = [
  { first: "Marcus", at: "2026-10-29T18:00:00Z", service: "Haircut", barber: "Drew" },
  { first: "Tyler", last: "Brooks", at: "2026-10-27T22:00:00Z", service: "Haircut", barber: "Sam" },
];

// ── reading the screen, as a person would ────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri, Oct 30, 9:00 AM PDT" */
const WHEN = String.raw`(\w{3}), (\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) ([AP]M) ([A-Z]{2,5}|GMT[+-]\d+)`;
interface Seen {
  date: string;
  minutes: number;
  zone: string;
}
function readWhen(m: RegExpExecArray, i: number): Seen {
  const [mon, day, hh, mm, ap, zone] = [m[i + 1]!, Number(m[i + 2]), Number(m[i + 3]), Number(m[i + 4]), m[i + 5]!, m[i + 6]!];
  const month = MONTHS.indexOf(mon) + 1;
  // The person knows "today" is late October 2026: Jan-Sep means next year.
  const year = month >= 10 ? 2026 : 2027;
  const h = (hh % 12) + (ap === "PM" ? 12 : 0);
  return { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, minutes: h * 60 + mm, zone };
}
/** What the shop's clock calls that day's zone: the person expects PDT before Nov 1, PST after. */
const expectedZone = (date: string) => (date < "2026-11-01" ? "PDT" : "PST");
const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localMinutes = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
};
const zoneOf = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value;
/** How the person remembers their own booking. */
const remembered = (ref: Ref) => {
  const at = new Date(FIXTURE[ref].at);
  return { date: localDate(at), minutes: localMinutes(at), zone: zoneOf(at), service: FIXTURE[ref].service, barber: FIXTURE[ref].barber };
};

const SLOT_RE = new RegExp(`^${WHEN} · (\\w+) · \\$(\\d+(?:\\.\\d\\d)?)$`);
const APPT_RE = new RegExp(`^(?:(Move|Cancel) )?${WHEN} · (.+) with (\\w+)$`);
const OWN_RE = new RegExp(`^(.+) on ${WHEN}$`);
const BOOK_RE = new RegExp(`(?:^|\\. )Book (.+) with (\\w+) at (.+), ${WHEN}, \\$(\\d+(?:\\.\\d\\d)?)\\?$`);
const MOVE_RE = new RegExp(`(?:^|\\. )Move your (.+) at (.+) from ${WHEN} to ${WHEN} with (\\w+), \\$(\\d+(?:\\.\\d\\d)?)\\?$`);
const CANCEL_RE = new RegExp(`(?:^|\\. )Cancel your (.+) with (\\w+) at (.+), ${WHEN}\\?`);
const DAY_RE = /^(\w{3}), (\w{3}) (\d{1,2})$/;

function slotOf(label: string) {
  const m = SLOT_RE.exec(label);
  return m ? { ...readWhen(m, 1), barber: m[8]!, price: Number(m[9]) } : null;
}
function apptOf(label: string) {
  const m = APPT_RE.exec(label);
  return m ? { verb: m[1] as "Move" | "Cancel" | undefined, ...readWhen(m, 2), service: m[9]!, barber: m[10]! } : null;
}
function dayOf(label: string, today: string): string | null {
  if (label === "Today") return today;
  if (label === "Tomorrow") return addDays(today, 1);
  const m = DAY_RE.exec(label);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!) + 1;
  return `${month >= 10 ? 2026 : 2027}-${String(month).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sameAppt = (a: { date: string; minutes: number; service?: string; barber?: string }, ref: Ref) => {
  const r = remembered(ref);
  return a.date === r.date && a.minutes === r.minutes && (a.service === undefined || a.service === r.service) && (a.barber === undefined || a.barber === r.barber);
};
const partOk = (minutes: number, part?: "morning" | "afternoon") => !part || (part === "morning" ? minutes < 720 : minutes >= 720);

/** Which booking does this reply's own words say it is about ("Move your Skin Fade on Wed, ... to:")? */
function aboutAppt(text: string): Ref | null {
  const m = new RegExp(`(?:Move your|move your) (.+?) on ${WHEN}`).exec(text);
  if (!m) return null;
  const seen = { ...readWhen(m, 2), service: m[1]! };
  return (["A1", "A2", "A3"] as Ref[]).find((r) => sameAppt(seen, r)) ?? null;
}

/**
 * Is this preview SENTENCE exactly what the person wanted? Every figure:
 * shop, service, barber, day, time, zone, price. Returns what it read, too,
 * so the saved row can be checked against the very same words.
 */
function previewServes(goal: Goal, summary: string): { ok: boolean; read: Record<string, unknown> | null; kind: string } {
  const b = BOOK_RE.exec(summary);
  if (b) {
    const w = readWhen(b, 4);
    const read = { kind: "book", service: b[1]!, barber: b[2]!, shop: b[3]!, ...w, price: Number(b[11]) };
    const ok =
      goal.type === "book" &&
      read.shop === SHOP_NAME &&
      read.service === goal.service &&
      w.date === goal.date &&
      (!goal.barber || read.barber === goal.barber) &&
      partOk(w.minutes, goal.timeOfDay) &&
      w.zone === expectedZone(w.date) &&
      read.price === PRICE[goal.service];
    return { ok, read, kind: "book" };
  }
  const mv = MOVE_RE.exec(summary);
  if (mv) {
    const from = readWhen(mv, 3);
    const to = readWhen(mv, 10);
    const read = { kind: "move", service: mv[1]!, shop: mv[2]!, from, ...to, barber: mv[17]!, price: Number(mv[18]) };
    const ok =
      goal.type === "reschedule" &&
      read.shop === SHOP_NAME &&
      sameAppt({ ...from, service: read.service }, goal.appointment) &&
      from.zone === expectedZone(from.date) &&
      to.date === goal.toDate &&
      to.zone === expectedZone(to.date) &&
      read.price === PRICE[read.service];
    return { ok, read, kind: "move" };
  }
  const c = CANCEL_RE.exec(summary);
  if (c) {
    const w = readWhen(c, 4);
    const read = { kind: "cancel", service: c[1]!, barber: c[2]!, shop: c[3]!, ...w };
    const ok = goal.type === "cancel" && read.shop === SHOP_NAME && sameAppt({ ...w, service: read.service, barber: read.barber }, goal.appointment) && w.zone === expectedZone(w.date);
    return { ok, read, kind: "cancel" };
  }
  return { ok: false, read: null, kind: "unreadable" };
}

/** How well a button's LABEL (in the context of its reply's words) serves the goal; 0 = it doesn't. */
function score(goal: Goal, label: string, reply: { text: string }, today: string, listedDays: string[]): number {
  const menuFor: Partial<Record<Goal["type"], string>> = { book: "Book", reschedule: "Reschedule", cancel: "Cancel", view: "My appointments", ask_shop: "Ask the shop" };
  if (label === menuFor[goal.type]) return 1;
  switch (goal.type) {
    case "book": {
      if (label === goal.service) return 3;
      const s = slotOf(label);
      if (s && reply.text.includes(`Open times for ${goal.service} at`)) {
        return s.date === goal.date && (!goal.barber || s.barber === goal.barber) && partOk(s.minutes, goal.timeOfDay) && s.zone === expectedZone(s.date) && s.price === PRICE[goal.service] ? 10 : 0;
      }
      if (reply.text === `Which day for your ${goal.service}?`) {
        if (dayOf(label, today) === goal.date) return 4;
        if (label === "Later dates" && !listedDays.includes(goal.date) && listedDays.every((d) => d < goal.date)) return 2;
      }
      return 0;
    }
    case "reschedule": {
      const about = aboutAppt(reply.text);
      const s = slotOf(label);
      if (s && about === goal.appointment) return s.date === goal.toDate && s.zone === expectedZone(s.date) ? 10 : 0;
      if (about === goal.appointment && /^When would you like to move/.test(reply.text)) {
        if (dayOf(label, today) === goal.toDate) return 4;
        if (label === "Later dates" && !listedDays.includes(goal.toDate) && listedDays.every((d) => d < goal.toDate)) return 2;
      }
      const a = apptOf(label);
      const forMove = a?.verb === "Move" || (!a?.verb && /want to move\?$/.test(reply.text));
      return a && forMove && sameAppt(a, goal.appointment) ? 3 : 0;
    }
    case "cancel": {
      const a = apptOf(label);
      const forCancel = a?.verb === "Cancel" || (!a?.verb && /want to cancel\?$/.test(reply.text));
      return a && forCancel && sameAppt(a, goal.appointment) ? 5 : 0;
    }
    default:
      return 0;
  }
}

/** A question back to the person (what / which), read from the words alone. */
const isAsk = (text: string) =>
  /^(What would you like to book\?|Which appointment do you want to (move|cancel)\?|Which one\?|I can find you a time|What would you like to do\?)/.test(text);

/** The wrong THING offered, read from the screen: times for the wrong booking, service or day. */
function offerProblem(goal: Goal, r: TurnReply, today: string, isFinal: boolean): string | undefined {
  const about = aboutAppt(r.text);
  const slots = r.choices.map((c) => slotOf(c.label)).filter((s): s is NonNullable<ReturnType<typeof slotOf>> => s !== null);
  if (about && slots.length && (goal.type !== "reschedule" || about !== goal.appointment)) {
    return `offered to move ${about} (wanted ${goal.type === "reschedule" ? `to move ${goal.appointment}` : goal.type})`;
  }
  const m = /^(?:.*\. )?Open times for (.+) at /.exec(r.text);
  if (m && slots.length) {
    if (goal.type !== "book") return `offered booking times (wanted ${goal.type})`;
    if (isFinal && (m[1] !== goal.service || !slots.some((s) => s.date === goal.date && (!goal.barber || s.barber === goal.barber)))) {
      return "offered times for the wrong service, day or barber";
    }
  }
  void today;
  return undefined;
}

const NAV_FOR: Partial<Record<Goal["type"], NavKey>> = { book: "book", reschedule: "move", cancel: "cancel", view: "appointments", ask_shop: "ask" };

// ── one task ─────────────────────────────────────────────────────────────

type Snap = Map<string, { clientId: string | null; status: string; startsAt: number; staffId: string | null; serviceId: string | null; price: number | null }>;
async function snapshot(): Promise<Snap> {
  const rows = await prisma.appointment.findMany({ where: { shopId }, select: { id: true, clientId: true, status: true, startsAt: true, staffId: true, serviceId: true, priceAtBooking: true } });
  return new Map(rows.map((r) => [r.id, { clientId: r.clientId, status: r.status, startsAt: r.startsAt.getTime(), staffId: r.staffId, serviceId: r.serviceId, price: r.priceAtBooking === null ? null : Number(r.priceAtBooking) }]));
}

async function makeAppt(clientId: string, first: string, at: string, service: string, barber: string) {
  const startsAt = new Date(at);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: staff[barber]!,
      serviceId: svc[service]!,
      clientId,
      firstName: first,
      manageToken: randomToken(),
      startsAt,
      endsAt: new Date(startsAt.getTime() + (service === "Beard Trim" ? 15 : 30) * 60000),
      status: "BOOKED",
      priceAtBooking: PRICE[service]!,
    },
  });
}

interface TurnRow {
  say: string;
  expect: string;
  asked: boolean;
  preview?: string;
  previewOk?: boolean;
  offerProblem?: string;
  text: string;
  wroteWithoutConfirm: boolean;
}

async function runTask(task: Task) {
  const phone = `+1628${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const client = await prisma.client.create({ data: { shopId, acuityClientKey: `test:${randomToken(8)}`, magicToken: randomToken(), firstName: "Jordan", lastName: "Fixture", phone } });
  const ids = {} as Record<Ref, string>;
  for (const ref of ["A1", "A2", "A3"] as const) ids[ref] = (await makeAppt(client.id, "Jordan", FIXTURE[ref].at, FIXTURE[ref].service, FIXTURE[ref].barber)).id;
  const actor: AssistantActor = { accountId: `tasks-${CONFIG}-${task.id}-${randomToken(4)}`, shopId, clientId: client.id, phone, ambiguous: false };
  const before = await snapshot();
  const goal = task.goal;
  const today = localDate(NOW);

  const turns: TurnRow[] = [];
  const shown: string[] = []; // every preview's Confirm the person saw, for the stale-tap probe
  const used: Array<{ token: string; read: Record<string, unknown> }> = [];
  let taps = 0;
  let menuFallback = false;
  let reached = false; // view / ask_shop: the screen showed what was asked for
  let lastReply: TurnReply | null = null;
  let finalNoFit = false;
  const visibleSaved: string[] = [];
  const writes = async () => {
    const s = await snapshot();
    let n = 0;
    for (const [id, r] of s) {
      const b = before.get(id);
      if (r.clientId === client.id && r.status === "BOOKED" && (!b || b.status !== "BOOKED" || b.startsAt !== r.startsAt)) n++;
      if (b && b.status === "BOOKED" && r.status !== "BOOKED") n++;
    }
    return n;
  };

  // Phase 1: the scripted conversation (typed).
  if (CONFIG === "rules") {
    const said: string[] = [];
    for (const [i, t] of task.turns.entries()) {
      const w0 = await writes();
      const r = await runTurn(actor, { text: t.say, recent: said.slice(-3) }, NOW);
      said.push(t.say);
      const row: TurnRow = {
        say: t.say,
        expect: t.expect,
        asked: !r.confirm && isAsk(r.text),
        text: r.text.slice(0, 200),
        wroteWithoutConfirm: (await writes()) !== w0,
        offerProblem: offerProblem(goal, r, today, i === task.turns.length - 1),
      };
      if (r.confirm) {
        shown.push(r.confirm.token);
        row.preview = r.confirm.summary;
        row.previewOk = previewServes(goal, r.confirm.summary).ok;
      }
      turns.push(row);
      lastReply = r;
    }
  }

  // Phase 2: follow through - only by what the screen shows.
  const follow = async (start: TurnReply | null): Promise<"done" | "stuck"> => {
    let reply = start;
    const seen = new Set<string>();
    for (let step = 0; reply && step < 14; step++) {
      if (goal.type === "view" && (["A1", "A2", "A3"] as Ref[]).every((r) => reply!.text.split("\n").some((line) => {
        const a = apptOf(line);
        return a !== null && sameAppt(a, r);
      }))) return (reached = true), "done";
      if (goal.type === "ask_shop" && reply.text.startsWith(`To reach ${SHOP_NAME} directly:`)) return (reached = true), "done";
      if (reply.confirm) {
        const pv = previewServes(goal, reply.confirm.summary);
        if (pv.ok) {
          const c = await runConfirm(actor, reply.confirm.token, NOW);
          used.push({ token: reply.confirm.token, read: pv.read! });
          if (c.ok) return "done";
          if (c.confirm) {
            shown.push(c.confirm.token);
            reply = { ...reply, text: c.text, choices: [], confirm: c.confirm };
            continue;
          }
          return "stuck";
        }
      }
      const listedDays = reply.choices.map((c) => dayOf(c.label, today)).filter((d): d is string => d !== null);
      // Never tap the same button on the same SCREEN twice (a loop) - the
      // screen being its words and every button on it, so "Later dates" on
      // the next page is a different tap.
      const screen = `${reply.text}|${reply.choices.map((c) => c.label).join("|")}`;
      const best = reply.choices
        .map((c) => ({ c, s: score(goal, c.label, reply!, today, listedDays) }))
        .filter((x) => x.s > 0 && !seen.has(`${x.c.label}@${screen}`))
        .sort((a, b) => b.s - a.s)[0];
      if (!best) return "stuck";
      seen.add(`${best.c.label}@${screen}`);
      taps++;
      reply = await runTurn(actor, { pick: best.c.pick }, NOW);
      if (reply.confirm) shown.push(reply.confirm.token);
    }
    return "stuck";
  };

  let outcome: "done" | "stuck" = "stuck";
  if (goal.type !== "none") {
    if (CONFIG === "buttons") {
      outcome = await follow(await runTurn(actor, { nav: NAV_FOR[goal.type]! }, NOW));
    } else {
      if (lastReply && goal.type === "book") {
        const slots = lastReply.choices.map((c) => slotOf(c.label)).filter(Boolean);
        if (slots.length && !lastReply.choices.some((c) => score(goal, c.label, lastReply!, today, []) >= 10)) finalNoFit = true;
      }
      outcome = await follow(lastReply);
      if (outcome === "stuck") {
        menuFallback = true;
        outcome = await follow(await runTurn(actor, { nav: NAV_FOR[goal.type]! }, NOW));
      }
    }
  }

  // 🔴 What was saved vs the sentence that was confirmed - every figure.
  for (const u of used) {
    const r = u.read;
    if (r.kind === "cancel") continue;
    const rows = await prisma.appointment.findMany({
      where: { shopId, clientId: client.id, status: "BOOKED", startsAt: { gt: NOW } },
      select: { startsAt: true, priceAtBooking: true, service: { select: { name: true } }, staff: { select: { name: true } }, shop: { select: { name: true } } },
    });
    const match = rows.find(
      (a) =>
        localDate(a.startsAt) === r.date &&
        localMinutes(a.startsAt) === r.minutes &&
        zoneOf(a.startsAt) === r.zone &&
        a.service.name === r.service &&
        a.staff.name === r.barber &&
        a.shop.name === r.shop &&
        Number(a.priceAtBooking) === r.price,
    );
    if (!match) visibleSaved.push(`confirmed "${JSON.stringify(r)}" but no saved booking has exactly those figures`);
  }

  // Probes: every preview shown and NOT confirmed is stale now - tapping it
  // must change nothing. Every Confirm used, tapped again, must not repeat.
  const staleAccepted: string[] = [];
  for (const t of shown) {
    if (used.some((u) => u.token === t)) continue;
    if ((await runConfirm(actor, t, NOW)).ok) staleAccepted.push("a stale preview went through");
  }
  for (const u of used) await runConfirm(actor, u.token, NOW);

  // Judge by the database.
  const after = await snapshot();
  const problems: string[] = [...staleAccepted, ...visibleSaved];
  for (const [id, b] of before) {
    if (b.clientId !== client.id && JSON.stringify(after.get(id)) !== JSON.stringify(b)) problems.push("someone else's booking changed");
  }
  const ownNew = [...after].filter(([id, r]) => !before.has(id) && r.clientId === client.id && r.status === "BOOKED");
  const holds = [...after].filter(([id, r]) => !before.has(id) && r.clientId === client.id && r.status === "PENDING").length;
  const changed = (ref: Ref) => {
    const b = before.get(ids[ref])!;
    const a = after.get(ids[ref])!;
    return a.status !== b.status || a.startsAt !== b.startsAt || a.staffId !== b.staffId;
  };
  const untouched = (except?: Ref) => (["A1", "A2", "A3"] as const).filter((r) => r !== except).every((r) => !changed(r));
  let completed = false;
  if (goal.type === "book") {
    const ok = ownNew.filter(([, r]) => {
      const at = new Date(r.startsAt);
      return r.serviceId === svc[goal.service] && localDate(at) === goal.date && (!goal.barber || r.staffId === staff[goal.barber]) && partOk(localMinutes(at), goal.timeOfDay) && r.price === PRICE[goal.service];
    });
    completed = ok.length === 1 && ownNew.length === 1 && untouched();
    if (ownNew.length > 1) problems.push(`duplicate: ${ownNew.length} new bookings`);
    if (ownNew.length && !ok.length) problems.push("booked something other than asked");
    if (!untouched()) problems.push("an existing booking changed while booking");
  } else if (goal.type === "reschedule") {
    const a = after.get(ids[goal.appointment])!;
    completed = a.status === "BOOKED" && localDate(new Date(a.startsAt)) === goal.toDate && untouched(goal.appointment) && !ownNew.length;
    if (!untouched(goal.appointment)) problems.push("a different booking changed");
    if (ownNew.length) problems.push("a new booking was made during a move");
  } else if (goal.type === "cancel") {
    completed = after.get(ids[goal.appointment])!.status === "CANCELED" && untouched(goal.appointment) && !ownNew.length;
    if (!untouched(goal.appointment)) problems.push("a different booking changed");
    if (ownNew.length) problems.push("a booking was made during a cancel");
  } else {
    completed = untouched() && !ownNew.length && (goal.type === "none" ? !lastReply?.confirm : reached);
    if (!untouched() || ownNew.length) problems.push("something changed when nothing should have");
  }
  if (turns.some((t) => t.wroteWithoutConfirm)) problems.push("a write happened without a Confirm");
  // Told one thing, saved another: never a success, whatever was saved.
  if (visibleSaved.length) completed = false;

  // Leave the shop as it was for the next task.
  await prisma.appointment.deleteMany({ where: { shopId, clientId: client.id } });
  await prisma.assistantConfirmation.deleteMany({ where: { shopId, actor: `c:${actor.accountId}` } });

  return { id: task.id, category: task.category, goal, completed, completedInFlow: completed && !menuFallback, menuFallback, taps, outcome, finalNoFit, lingeringHolds: holds, problems, turns };
}

// ── the run ──────────────────────────────────────────────────────────────

describe.skipIf(!RUN)(`task evaluation (${CONFIG})`, () => {
  let set: { now: string; timezone: string; tasks: Task[] };
  let sha = "";

  beforeAll(async () => {
    const raw = readFileSync(FILE);
    sha = createHash("sha256").update(raw).digest("hex");
    set = JSON.parse(raw.toString("utf8"));
    NOW = new Date(set.now);
    TZ = set.timezone;
    process.env.ASSISTANT_CHAT_ENABLED = "true";
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
    __resetEnvCacheForTests();
    const { createApp } = await import("../app.js");
    app = createApp();
    const signup = await request(app).post("/api/auth/signup").send({ email: ownerEmail, password: "supersecret123", name: "Tasks Owner", smsAttested: true, acceptTerms: true });
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    shopId = (await request(app).post("/api/shops").set("Cookie", cookie).send({ name: SHOP_NAME, bookingUrl: "https://book.test", smsAttested: true })).body.id;
    await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 1 });
    for (const name of ["Drew", "Sam"]) staff[name] = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name })).body.id;
    for (const [name, p, durationMin, who] of [
      ["Haircut", 35, 30, ["Drew", "Sam"]],
      ["Skin Fade", 40, 30, ["Drew", "Sam"]],
      ["Beard Trim", 20, 15, ["Drew"]],
      ["Kids Cut", 25, 30, ["Sam"]],
    ] as const) {
      PRICE[name] = p;
      svc[name] = (await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name, durationMin, price: p, staffIds: who.map((w) => staff[w]) })).body.id;
    }
    for (const id of Object.values(staff)) {
      await request(app)
        .put(`/api/booking/staff/${id}/availability`)
        .set("Cookie", cookie)
        .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
    }
    await prisma.shop.update({ where: { id: shopId }, data: { compAccess: true, hoursText: "Open every day, 9 AM to 5 PM.", addressStreet: "100 Fixture St", addressCity: "Los Angeles" } });
    for (const [i, o] of OTHERS.entries()) {
      const c = await prisma.client.create({ data: { shopId, acuityClientKey: `test:${randomToken(8)}`, magicToken: randomToken(), firstName: o.first, lastName: o.last ?? "Other", phone: `+1628555${String(i).padStart(4, "0")}` } });
      await makeAppt(c.id, o.first, o.at, o.service, o.barber);
    }
  });

  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    for (const k of ["ASSISTANT_CHAT_ENABLED", "CUSTOMER_ACCOUNTS_ENABLED"]) delete process.env[k];
    __resetEnvCacheForTests();
    await prisma.$disconnect();
  });

  it("runs every task", { timeout: 60 * 60 * 1000 }, async () => {
    const rows: Array<Awaited<ReturnType<typeof runTask>>> = [];
    for (const task of set.tasks) rows.push(await runTask(task));
    const turns = rows.flatMap((r) => r.turns);
    const count = (f: (t: TurnRow) => boolean) => turns.filter(f).length;
    const byCat: Record<string, { n: number; completed: number; inFlow: number }> = {};
    for (const r of rows) {
      const c = (byCat[r.category] ??= { n: 0, completed: 0, inFlow: 0 });
      c.n++;
      if (r.completed) c.completed++;
      if (r.completedInFlow) c.inFlow++;
    }
    const notChangeOfMindStart = (r: (typeof rows)[number], i: number) => !(r.category === "change_of_mind" && i < r.turns.length - 1);
    const summary = {
      config: CONFIG,
      file: FILE,
      sha256: sha,
      tasks: rows.length,
      completed: rows.filter((r) => r.completed).length,
      completedInFlow: rows.filter((r) => r.completedInFlow).length,
      rescuedByMenu: rows.filter((r) => r.completed && r.menuFallback).length,
      notCompleted: rows.filter((r) => !r.completed).map((r) => r.id),
      taps: rows.reduce((n, r) => n + r.taps, 0),
      turns: turns.length,
      askTurns: count((t) => t.expect === "ask"),
      correctClarifications: count((t) => t.expect === "ask" && t.asked),
      missedClarifications: count((t) => t.expect === "ask" && !t.asked),
      actTurns: count((t) => t.expect === "act"),
      unnecessaryClarifications: count((t) => t.expect === "act" && t.asked),
      // The change-of-mind tasks' first previews are what was asked AT THAT
      // TURN (the goal is what they end up wanting), so they are not counted.
      wrongPreviews: rows.flatMap((r) =>
        r.turns.filter((t, i) => t.preview && !t.previewOk && notChangeOfMindStart(r, i) && r.goal.type !== "none").map((t) => `${r.id}: "${t.say}" -> ${t.preview}`),
      ),
      wrongOffers: rows.flatMap((r) => r.turns.filter((t, i) => t.offerProblem && notChangeOfMindStart(r, i)).map((t) => `${r.id}: "${t.say}" -> ${t.offerProblem}`)),
      finalOfferNoFit: rows.filter((r) => r.finalNoFit).map((r) => r.id),
      visibleVsSavedMismatches: rows.flatMap((r) => r.problems.filter((p) => p.startsWith("confirmed")).map((p) => `${r.id}: ${p}`)),
      unauthorizedOrDuplicate: rows.filter((r) => r.problems.length).map((r) => ({ id: r.id, problems: r.problems })),
      lingeringHolds: rows.reduce((n, r) => n + r.lingeringHolds, 0),
      byCategory: byCat,
    };
    writeFileSync(process.env.ASSISTANT_TASKS_OUT ?? `assistant-tasks-${CONFIG}.json`, JSON.stringify({ summary, rows }, null, 2));
  });
});
