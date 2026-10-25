import { apiEnv, zonedDateParts, zonedMinutesOfDay } from "@chairback/config";
import { forShop, prisma, Prisma, runAsOwner, runWithShop } from "@chairback/db";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { logger } from "../logger.js";
import { formatApptTime } from "../messaging/templates.js";
import { PUBLIC_SERVICE } from "../engines/serviceVisibility.js";
import { decodeSlotId, makeToolExecutor, type ToolContext } from "../receptionist/tools.js";
import { decideAction } from "./actions.js";
import { guidedProposal, addDays, isNeverMind, preRule, type TurnContext } from "./guided.js";
import {
  claimConfirm,
  loadConfirm,
  mintConfirm,
  readPick,
  releaseConfirm,
  settleConfirm,
  signPick,
  type ConfirmRow,
} from "./confirm.js";
import { notifyAppointmentConfirmation, notifyBarberBookingEvent } from "../services/appointmentNotify.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { checkPolicyAcceptance } from "../engines/bookingPolicy.js";
import { bookingQuestionsForShop, questionsForService, resolveIntake } from "../engines/bookingIntake.js";

/**
 * ONE BOOKING-CHAT TURN.
 *
 *   nav   (a menu tap: Book, My appointments, Reschedule, Cancel, Ask the shop)
 *   pick  (a signed button the server drew)
 *   text  ──server rules (guided.ts)──▶ one action
 *         ──decideAction──▶ known, args valid, button-only actions refused
 *         ──run──▶ reads answer at once; changes answer with a PREVIEW + a
 *                  confirm token, and nothing changes until /confirm.
 *
 * Every change goes through the receptionist's booking tools
 * (receptionist/tools.ts) - the same availability, notice, horizon, blocked
 * clients, change rules, double-booking locks and prices as the booking page.
 * There is no model: every sentence the person reads is written here from
 * live data, and every preview names the shop, service, barber, day, time,
 * time zone and price that the tap will save.
 */

export interface AssistantActor {
  /** The signed-in customer account (customer-auth session). */
  accountId: string;
  shopId: string;
  /** The ONE client record this account is proven to be at this shop, or null. */
  clientId: string | null;
  phone: string | null;
  /** More than one record could be theirs here (a shared phone): no writes. */
  ambiguous: boolean;
}

export interface Choice {
  label: string;
  /** A signed button (confirm.ts signPick); send it back as `pick`. */
  pick: string;
}

export interface TurnReply {
  /** button = a menu tap or a signed button; rules = typed text, read by guided.ts. */
  via: "button" | "rules";
  action: string;
  text: string;
  choices: Choice[];
  confirm?: { token: string; summary: string };
  link?: { label: string; url: string };
  timing: { totalMs: number };
}

const actorKey = (a: AssistantActor) => `c:${a.accountId}`;

// ── context ──────────────────────────────────────────────────────────────

interface Ctx extends TurnContext {
  shop: {
    id: string;
    name: string;
    slug: string | null;
    timezone: string;
    paymentsMode: string;
    requireCardToBook: boolean;
    // The booking page's own rules, which a chat booking must not get around.
    requireBookingApproval: boolean;
    subscriptionStatus: string;
    trialEndsAt: Date | null;
    compAccess: boolean;
    bookingPolicyText: string | null;
    bookingPolicyChecklist: string[];
  };
  /** ref -> appointment id. Only the actor's own. */
  refIds: Map<string, string>;
}

async function loadContext(actor: AssistantActor, now: Date): Promise<Ctx> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: actor.shopId },
    select: {
      id: true,
      name: true,
      slug: true,
      timezone: true,
      paymentsMode: true,
      requireCardToBook: true,
      requireBookingApproval: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      compAccess: true,
      bookingPolicyText: true,
      bookingPolicyChecklist: true,
    },
  });
  const db = forShop(shop.id);
  const [services, staff] = await Promise.all([
    db.service.findMany({ where: { shopId: shop.id, ...PUBLIC_SERVICE }, select: { name: true }, orderBy: { name: "asc" } }),
    db.staff.findMany({ where: { shopId: shop.id, active: true }, select: { name: true } }),
  ]);
  const appointments: Ctx["appointments"] = [];
  const refIds = new Map<string, string>();
  if (actor.clientId) {
    const clientId = actor.clientId;
    const upcoming = await runWithShop(shop.id, (tx) =>
      tx.appointment.findMany({
        where: { shopId: shop.id, clientId, status: "BOOKED", startsAt: { gt: now } },
        orderBy: { startsAt: "asc" },
        take: 6,
        select: { id: true, startsAt: true, service: { select: { name: true } }, staff: { select: { name: true } } },
      }),
    );
    upcoming.forEach((a, i) => {
      const ref = `A${i + 1}`;
      refIds.set(ref, a.id);
      appointments.push({
        ref,
        date: dayOf(a.startsAt, shop.timezone),
        // What a person reads to tell two bookings apart: day, time, zone, service, barber.
        label: `${when(a.startsAt, shop.timezone)} · ${a.service.name} with ${a.staff.name}`,
        service: a.service.name,
        staff: a.staff.name,
        minutes: zonedMinutesOfDay(a.startsAt, shop.timezone),
      });
    });
  }
  return {
    shop: { ...shop, paymentsMode: String(shop.paymentsMode) },
    today: dayOf(now, shop.timezone),
    services: services.map((s) => s.name),
    barbers: staff.map((s) => s.name),
    appointments,
    refIds,
  };
}

function dayOf(at: Date, tz: string): string {
  const p = zonedDateParts(at, tz);
  return `${p.year}-${String(p.month0 + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The zone's own short name AT that instant ("PDT", then "PST" after the change). */
export function zoneAbbrev(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Fri, Oct 30, 9:00 AM PDT" - the day, time AND zone, in the shop's clock. */
export function when(at: Date, timeZone: string): string {
  return `${formatApptTime(at, timeZone)} ${zoneAbbrev(at, timeZone)}`;
}

// ── the turn ─────────────────────────────────────────────────────────────

/** The menu, by name: reliable entry points that need no interpretation. */
export const NAV = {
  menu: "menu",
  book: "book_start",
  appointments: "my_appointments",
  move: "move_start",
  cancel: "cancel_start",
  ask: "ask_shop",
} as const;
export type NavKey = keyof typeof NAV;

const REFUSED = { action: "refused", text: "I can't do that here.", choices: [] as Choice[] };

export async function runTurn(
  actor: AssistantActor,
  input: { text?: string; recent?: string[]; pick?: string; nav?: NavKey },
  now = new Date(),
): Promise<TurnReply> {
  const started = Date.now();
  const ctx = await loadContext(actor, now);

  // 🔴 A NEW REQUEST REPLACES WHATEVER WAS ON THE TABLE. Every message and
  // every tap retires this person's open previews on the SERVER (the old
  // Confirm buttons stop working) and lets go of any time they held - by the
  // same compare-and-set a Confirm uses, so a tap racing this turn either
  // completed first (and "never mind" says so truthfully) or was replaced.
  const superseded = await supersedePending(actor, now);

  if (input.nav) {
    const d = decideAction({ name: NAV[input.nav], args: {} }, false);
    if (!d.ok) return finish(started, { via: "button", ...REFUSED });
    return finish(started, { ...(await execute(actor, ctx, d.name, d.args, now)), via: "button" });
  }

  if (input.pick) {
    // A button lives 30 minutes of WALL-CLOCK time (signPick stamps it with
    // Date.now()), whatever clock the booking rules run on.
    const pick = readPick(input.pick, { actor: actorKey(actor), shopId: actor.shopId }, Date.now());
    if (!pick) return finish(started, { via: "button", action: "refused", text: "That button has expired. Ask again and I'll pull it up fresh.", choices: [] });
    const d = decideAction({ name: pick.name, args: pick.args }, false);
    if (!d.ok) return finish(started, { via: "button", ...REFUSED });
    return finish(started, { ...(await execute(actor, ctx, d.name, d.args, now)), via: "button" });
  }

  const text = (input.text ?? "").slice(0, 500);
  if (isNeverMind(text, ctx)) return finish(started, { ...(await neverMind(actor, ctx, superseded, now)), via: "rules" });
  // Rule-bending messages, someone else's booking and two services at once
  // are decided first; then the rules read what is asked for.
  const proposal = preRule(text, ctx) ?? guidedProposal(text, ctx, input.recent ?? []);
  const d = decideAction(proposal, true);
  if (!d.ok) return finish(started, { via: "rules", ...REFUSED });
  return finish(started, { ...(await execute(actor, ctx, d.name, d.args, now)), via: "rules" });
}

function finish(started: number, r: Omit<TurnReply, "timing" | "choices"> & { choices?: Choice[] }): TurnReply {
  return { choices: [], ...r, timing: { totalMs: Date.now() - started } };
}

// ── executing an allowed action ──────────────────────────────────────────

type Out = Omit<TurnReply, "timing" | "via">;

function toolCtx(actor: AssistantActor, now: Date): ToolContext {
  return {
    shopId: actor.shopId,
    // No SMS thread: escalate_to_human is not reachable from here.
    conversationId: `assistant:${actorKey(actor)}`,
    phone: actor.phone ?? "",
    clientId: actor.clientId,
    now,
    origin: "assistant",
  };
}

async function tool(actor: AssistantActor, now: Date, name: string, input: unknown): Promise<{ ok: boolean; data: any; text: string }> {
  const r = await makeToolExecutor(toolCtx(actor, now))(name, input);
  let data: any = null;
  try {
    data = JSON.parse(r.result);
  } catch {
    data = null;
  }
  return { ok: !r.isError, data, text: r.result };
}

function pick(actor: AssistantActor, name: string, args: Record<string, string>): string {
  return signPick({ actor: actorKey(actor), shopId: actor.shopId, name, args });
}

const dollars = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

async function execute(actor: AssistantActor, ctx: Ctx, name: string, args: Record<string, unknown>, now: Date): Promise<Out> {
  switch (name) {
    case "unsupported":
      // Fixed words, no buttons, no preview: nothing in the message is acted on.
      return {
        action: name,
        text:
          args.reason === "someone_else"
            ? "I can only see and change your own appointments. They can sign in and change theirs, or call the shop."
            : "I can only help with your own appointments here: finding a time, booking, moving or cancelling, and every change waits for your tap.",
        choices: [],
      };

    case "one_at_a_time": {
      const services = (args.services as string[]).filter((s) => ctx.services.includes(s));
      return {
        action: name,
        text: `I can book one service at a time here. Which first: ${services.join(" or ")}?`,
        choices: services.map((s) => ({
          label: s,
          pick: pick(actor, "find_openings", { service: s, ...(args.date ? { date: String(args.date) } : {}) }),
        })),
      };
    }

    case "clarify":
      return {
        action: "clarify",
        text:
          args.missing === "service"
            ? `What would you like to book? ${ctx.services.slice(0, 6).join(", ")}.`
            : args.missing === "date"
              ? "Which day works for you?"
              : args.missing === "appointment"
                ? ctx.appointments.length
                  ? `Which one? ${ctx.appointments.map((a) => a.label).join("; ")}.`
                  : "I don't see an upcoming appointment for you here."
                : "I can find you a time, book it, or move or cancel one of your appointments.",
        choices:
          args.missing === "appointment"
            ? myAppointmentChoices(actor, ctx)
            : args.missing === "service"
              ? ctx.services.map((s) => ({ label: s, pick: pick(actor, "book_service", { service: s }) }))
              : args.missing === "what"
                ? menuChoices(actor)
                : [],
      };

    case "menu":
      return { action: name, text: "What would you like to do?", choices: menuChoices(actor) };

    case "book_start": {
      // Up front, so nobody picks a day and a time only to be told at the end.
      const gate = bookingGate(actor, ctx, now);
      if (gate) return { ...gate, action: name };
      return {
        action: name,
        text: ctx.services.length ? "What would you like to book?" : "There's nothing on the menu to book yet.",
        choices: ctx.services.map((s) => ({ label: s, pick: pick(actor, "book_service", { service: s }) })),
      };
    }

    case "book_service": {
      const service = ctx.services.find((s) => s === args.service);
      if (!service) return { action: name, text: "That service isn't on the menu any more.", choices: [] };
      const from = (args.from as string | undefined) ?? ctx.today;
      const later = laterFrom(ctx, from);
      return {
        action: name,
        text: `Which day for your ${service}?`,
        choices: [
          ...(from === ctx.today ? [{ label: "Soonest", pick: pick(actor, "find_openings", { service }) }] : []),
          ...nextDays(ctx, from).map((d) => ({ label: d.label, pick: pick(actor, "find_openings", { service, date: d.date }) })),
          ...(later ? [{ label: "Later dates", pick: pick(actor, "book_service", { service, from: later }) }] : []),
        ],
      };
    }

    case "move_start":
    case "cancel_start": {
      if (!ctx.appointments.length) return { action: name, text: "You have no upcoming appointments here.", choices: [{ label: "Book", pick: pick(actor, "book_start", {}) }] };
      const move = name === "move_start";
      return {
        action: name,
        text: move ? "Which appointment do you want to move?" : "Which appointment do you want to cancel?",
        choices: ctx.appointments.map((a) => ({
          label: a.label,
          pick: pick(actor, move ? "pick_move" : "pick_cancel", { appointment_id: ctx.refIds.get(a.ref)! }),
        })),
      };
    }

    case "choose_appointment": {
      // Several bookings fit the words: the person chooses, seeing each one.
      const move = args.intent === "move";
      const refs = (args.refs as string[]).filter((r) => ctx.refIds.has(r));
      return {
        action: name,
        text: move ? "Which appointment do you want to move?" : "Which appointment do you want to cancel?",
        choices: refs.map((r) => ({
          label: ctx.appointments.find((a) => a.ref === r)!.label,
          pick: pick(actor, move ? "pick_move" : "pick_cancel", { appointment_id: ctx.refIds.get(r)! }),
        })),
      };
    }

    case "ask_shop": {
      const shop = await prisma.shop.findUnique({
        where: { id: ctx.shop.id },
        select: { name: true, hoursText: true, addressStreet: true, addressCity: true, instagramHandle: true },
      });
      const lines = [
        shop?.hoursText ? `Hours: ${shop.hoursText}` : null,
        shop?.addressStreet ? `Address: ${[shop.addressStreet, shop.addressCity].filter(Boolean).join(", ")}` : null,
        shop?.instagramHandle ? `Instagram: @${shop.instagramHandle}` : null,
      ].filter(Boolean);
      return {
        action: name,
        text: lines.length
          ? `To reach ${ctx.shop.name} directly:\n${lines.join("\n")}`
          : `${ctx.shop.name} hasn't listed contact details here yet. Your booking confirmation email has the shop's details.`,
        choices: [],
        link: bookingLink(ctx),
      };
    }

    case "move_day": {
      const own = await ownAppointment(actor, ctx, String(args.appointment_id), now);
      if (!own) return { action: name, text: "I couldn't find that appointment.", choices: myAppointmentChoices(actor, ctx) };
      return movesOn(actor, ctx, own, String(args.date), now, name, args.part as "morning" | "afternoon" | undefined);
    }

    case "list_services": {
      const rows = await forShop(ctx.shop.id).service.findMany({
        where: { shopId: ctx.shop.id, ...PUBLIC_SERVICE },
        select: { name: true, price: true, durationMin: true },
        orderBy: { name: "asc" },
      });
      return {
        action: name,
        text: rows.length
          ? rows.map((s) => `${s.name}: ${s.price !== null ? dollars(Number(s.price)) : "ask"} (${s.durationMin} min)`).join("\n")
          : "There's nothing on the menu yet.",
        choices: [],
      };
    }

    case "find_openings": {
      const off = lapsed(ctx, name, now);
      if (off) return off;
      const from = (args.date as string | undefined) ?? ctx.today;
      const to = (args.to_date as string | undefined) ?? (args.date ? from : addDays(from, 6));
      const barber = args.barber as string | undefined;
      let r = await tool(actor, now, "check_availability", { service: args.service, from_date: from, to_date: to, ...(barber ? { barber } : {}) });
      // 🔴 A barber who doesn't do that service is not "not on the menu" (a
      // customer was once told Beard Trim wasn't on a menu that listed it).
      // Say who does, and show their times.
      let lead = "";
      if (!r.ok && barber) {
        const anyone = await tool(actor, now, "check_availability", { service: args.service, from_date: from, to_date: to });
        if (anyone.ok) {
          r = anyone;
          lead = `${barber} doesn't do ${anyone.data.service}. `;
        }
      }
      if (!r.ok) return { action: name, text: `I couldn't find "${String(args.service)}" on the menu. We have: ${ctx.services.join(", ")}.`, choices: [] };
      const all = flattenSlots(r.data);
      // Morning / afternoon, when they said so - in the shop's own clock.
      const part = args.part as "morning" | "afternoon" | undefined;
      const fits = part ? all.filter((s) => slotPart(s.slot_id, ctx.shop.timezone) === part) : all;
      if (part && !fits.length && all.length) lead += `Nothing open in the ${part} then. `;
      const slots = (fits.length ? fits : all).slice(0, 6);
      if (!slots.length) return { action: name, text: `${lead}Nothing open for ${r.data.service} then. Want me to look at other days?`, choices: [] };
      return {
        action: name,
        text: `${lead}Open times for ${r.data.service} at ${ctx.shop.name}:`,
        choices: slots.map((s) => ({ label: slotLabel(s, ctx), pick: pick(actor, "pick_slot", { slot_id: s.slot_id }) })),
      };
    }

    case "my_appointments":
      return {
        action: name,
        text: ctx.appointments.length
          ? ctx.appointments.map((a) => a.label).join("\n")
          : !actor.clientId
            ? "I don't have you on file at this shop yet, so there's nothing to show."
            : "You have no upcoming appointments here.",
        choices: myAppointmentChoices(actor, ctx),
      };

    case "reschedule":
    case "pick_move": {
      const id = name === "reschedule" ? ctx.refIds.get(String(args.appointment)) : String(args.appointment_id);
      const own = id ? await ownAppointment(actor, ctx, id, now) : null;
      if (!own) return { action: name, text: "I couldn't find that appointment.", choices: myAppointmentChoices(actor, ctx) };
      const part = args.part as "morning" | "afternoon" | undefined;
      if (args.date) return movesOn(actor, ctx, own, String(args.date), now, name, part);
      // No new day named: pick the day first, then a time on it.
      return {
        action: name,
        text: `When would you like to move your ${own.label}?`,
        choices: moveDayChoices(actor, ctx, own.id, (args.from as string | undefined) ?? ctx.today, part),
      };
    }

    case "cancel":
    case "pick_cancel": {
      const id = name === "cancel" ? ctx.refIds.get(String(args.appointment)) : String(args.appointment_id);
      const own = id ? await ownAppointment(actor, ctx, id, now) : null;
      if (!own) return { action: name, text: "I couldn't find that appointment.", choices: myAppointmentChoices(actor, ctx) };
      if (actor.ambiguous) return ambiguousOut(ctx, name);
      return cancelPreview(actor, ctx, own, now, name);
    }

    case "pick_slot": {
      const slot = decodeSlotId(String(args.slot_id));
      // The service and barber they chose ride along to the booking page if
      // this has to finish there.
      const prefill = slot ? { serviceId: slot.serviceId, staffId: slot.staffId } : undefined;
      const gate = bookingGate(actor, ctx, now, prefill);
      if (gate) return gate;
      if (!slot) return { action: name, text: "That time is no longer valid. Ask again for fresh times.", choices: [] };
      if (await needsIntake(actor.shopId, slot.serviceId)) {
        return {
          action: name,
          text: "This service has a few questions to answer first, so finish on the booking page.",
          choices: [],
          link: bookingLink(ctx, prefill),
        };
      }
      const detail = await slotDetail(actor, now, slot, ctx);
      if (!detail) return { action: name, text: "That time was just taken. Ask again for fresh times.", choices: [] };
      // Hold it while they decide, so nobody else books it between the
      // preview and the tap (the receptionist's own 10-minute hold).
      const held = await tool(actor, now, "hold_slot", { slot_id: String(args.slot_id) });
      if (!held.ok) return { action: name, text: "That time was just taken. Ask again for fresh times.", choices: [] };
      const cents = Math.round(detail.price * 100);
      const summary = bookSummary(ctx, detail.service, detail.barber, slot.startsAt, cents);
      const token = await mintConfirm(
        {
          actor: actorKey(actor),
          shopId: actor.shopId,
          action: "book",
          args: { slot_id: String(args.slot_id), hold_id: String(held.data.hold_id), price_cents: cents },
          stateKey: `hold:${held.data.hold_id}|${slot.startsAt.toISOString()}|${slot.staffId}|${cents}`,
          summary,
        },
        now,
      );
      return { action: name, text: summary, choices: [], confirm: { token, summary } };
    }

    case "pick_new_slot": {
      if (actor.ambiguous) return ambiguousOut(ctx, name);
      // A lapsed shop can't churn its calendar from chat either (the manage
      // link's reschedule refuses the same).
      const off = lapsed(ctx, name, now);
      if (off) return off;
      const own = await ownAppointment(actor, ctx, String(args.appointment_id), now);
      const slot = decodeSlotId(String(args.slot_id));
      if (!own || !slot) return { action: name, text: "I couldn't find that appointment or time.", choices: [] };
      const detail = await slotDetail(actor, now, slot, ctx);
      if (!detail) return { action: name, text: "That time was just taken. Ask again for fresh times.", choices: [] };
      const state = await apptState(actor.shopId, own.id);
      const cents = Math.round(detail.price * 100);
      const summary = moveSummary(ctx, own, slot.startsAt, detail.barber, cents);
      const token = await mintConfirm(
        {
          actor: actorKey(actor),
          shopId: actor.shopId,
          action: "move",
          args: { appointment_id: own.id, slot_id: String(args.slot_id), price_cents: cents },
          stateKey: `${fingerprint(state!)}|to:${String(args.slot_id)}|${cents}`,
          summary,
        },
        now,
      );
      return { action: name, text: summary, choices: [], confirm: { token, summary } };
    }
  }
  return { action: name, text: "I can't do that here.", choices: [] };
}

// ── what the person reads: every preview names shop, service, barber, day,
//    time, zone and price - exactly what the tap will save ───────────────────

function bookSummary(ctx: Ctx, service: string, barber: string, at: Date, cents: number): string {
  return `Book ${service} with ${barber} at ${ctx.shop.name}, ${when(at, ctx.shop.timezone)}, ${dollars(cents / 100)}?`;
}

function moveSummary(ctx: Ctx, own: OwnAppt, to: Date, barber: string, cents: number): string {
  return `Move your ${own.serviceName} at ${ctx.shop.name} from ${when(own.startsAt, ctx.shop.timezone)} to ${when(to, ctx.shop.timezone)} with ${barber}, ${dollars(cents / 100)}?`;
}

function slotLabel(s: { slot_id: string; price: number; barber: string }, ctx: Ctx): string {
  const at = decodeSlotId(s.slot_id)!.startsAt;
  return `${when(at, ctx.shop.timezone)} · ${s.barber} · ${dollars(s.price)}`;
}

/** Open times on one day for moving `own`, as buttons. */
async function movesOn(actor: AssistantActor, ctx: Ctx, own: OwnAppt, date: string, now: Date, action: string, part?: "morning" | "afternoon"): Promise<Out> {
  const r = await tool(actor, now, "check_availability", { service: own.serviceName, from_date: date, to_date: date });
  const all = r.ok ? flattenSlots(r.data) : [];
  const fits = part ? all.filter((s) => slotPart(s.slot_id, ctx.shop.timezone) === part) : all;
  const slots = (fits.length ? fits : all).slice(0, 6);
  if (!slots.length) {
    return {
      action,
      text: `Nothing open on ${date} to move your ${own.serviceName} to. Another day?`,
      choices: moveDayChoices(actor, ctx, own.id, ctx.today, part),
    };
  }
  return {
    action,
    text: `${part && !fits.length ? `Nothing open in the ${part} then. ` : ""}Move your ${own.label} to:`,
    choices: slots.map((s) => ({ label: slotLabel(s, ctx), pick: pick(actor, "pick_new_slot", { appointment_id: own.id, slot_id: s.slot_id }) })),
  };
}

function myAppointmentChoices(actor: AssistantActor, ctx: Ctx): Choice[] {
  return ctx.appointments.flatMap((a) => [
    { label: `Move ${a.label}`, pick: pick(actor, "pick_move", { appointment_id: ctx.refIds.get(a.ref)! }) },
    { label: `Cancel ${a.label}`, pick: pick(actor, "pick_cancel", { appointment_id: ctx.refIds.get(a.ref)! }) },
  ]);
}

function ambiguousOut(ctx: Ctx, action: string): Out {
  return {
    action,
    text: "More than one client record here matches your number, so I can't change bookings from chat. Use the link in your confirmation, or the booking page.",
    choices: [],
    link: bookingLink(ctx),
  };
}

/**
 * The shop's booking page. With `prefill`, the service (and barber) the person
 * already chose in chat come pre-selected (the page's ?service=&staff=), so a
 * handoff never makes them start over. It never pre-selects a time: only the
 * page itself holds a slot.
 */
function bookingLink(ctx: Ctx, prefill?: { serviceId: string; staffId?: string }): { label: string; url: string } | undefined {
  if (!ctx.shop.slug) return undefined;
  const q = new URLSearchParams();
  if (prefill) {
    q.set("service", prefill.serviceId);
    if (prefill.staffId) q.set("staff", prefill.staffId);
  }
  const qs = q.toString();
  return { label: "Open the booking page", url: `${apiEnv().APP_BASE_URL}/book/${ctx.shop.slug}${qs ? `?${qs}` : ""}` };
}

/** A shop whose subscription lapsed takes no online bookings or moves (the booking page refuses them too). */
function lapsed(ctx: Ctx, action: string, now: Date): Out | null {
  if (hasActiveAccess(ctx.shop, { now })) return null;
  return { action, text: `${ctx.shop.name} isn't taking online bookings right now. Please contact the shop directly.`, choices: [] };
}

/**
 * 🔴 THE BOOKING PAGE'S RULES, NOT A WAY AROUND THEM. Booking from chat writes
 * no payment, asks no intake questions, shows no policy and makes no request
 * for approval - so a shop that needs any of those sends the person to its
 * booking page (which does them all) instead of chat booking around it. An
 * unknown or ambiguous person likewise; a lapsed shop takes no bookings at all.
 */
function bookingGate(
  actor: AssistantActor,
  ctx: Ctx,
  now: Date,
  prefill?: { serviceId: string; staffId?: string },
): Out | null {
  const off = lapsed(ctx, "pick_slot", now);
  if (off) return off;
  const handoff = (text: string): Out => ({ action: "pick_slot", text, choices: [], link: bookingLink(ctx, prefill) });
  const paysAtBooking =
    ctx.shop.paymentsMode === "ahead" || ctx.shop.paymentsMode === "deposit" || (ctx.shop.paymentsMode === "card_on_file" && ctx.shop.requireCardToBook);
  if (paysAtBooking) return handoff("This shop takes payment when you book, so finish on the booking page.");
  if (ctx.shop.requireBookingApproval) return handoff("This shop approves each booking itself, so send your request from the booking page.");
  if (!checkPolicyAcceptance(ctx.shop, undefined, now).ok) {
    return handoff("This shop asks you to agree to its booking policy first, so finish on the booking page.");
  }
  // Ambiguous first: a shared phone also leaves clientId null, and the person
  // should hear the real reason, not "book your first visit".
  if (actor.ambiguous) return ambiguousOut(ctx, "pick_slot");
  if (!actor.clientId) return handoff("Book your first visit on the booking page; after that I can book for you here.");
  return null;
}

/** Does this service ask a REQUIRED question the chat can't? Then the booking page asks it. */
async function needsIntake(shopId: string, serviceId: string): Promise<boolean> {
  return !resolveIntake(questionsForService(await bookingQuestionsForShop(shopId), serviceId), []).ok;
}

interface OwnAppt {
  id: string;
  /** "Skin Fade on Wed, Oct 28, 2:30 PM PDT" */
  label: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
}

/** An appointment that is THIS person's, at this shop, and still upcoming. */
async function ownAppointment(actor: AssistantActor, ctx: Ctx, id: string, now: Date): Promise<OwnAppt | null> {
  if (!actor.clientId) return null;
  const clientId = actor.clientId;
  const a = await runWithShop(actor.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id, shopId: actor.shopId, clientId, status: "BOOKED", startsAt: { gt: now } },
      select: { id: true, startsAt: true, service: { select: { name: true } }, staff: { select: { name: true } } },
    }),
  );
  if (!a) return null;
  return {
    id: a.id,
    label: `${a.service.name} on ${when(a.startsAt, ctx.shop.timezone)}`,
    serviceName: a.service.name,
    staffName: a.staff.name,
    startsAt: a.startsAt,
  };
}

/** The live price and barber for one slot, re-read from availability (null = not open). */
async function slotDetail(
  actor: AssistantActor,
  now: Date,
  slot: { staffId: string; serviceId: string; startsAt: Date },
  ctx: Ctx,
): Promise<{ service: string; barber: string; price: number } | null> {
  const db = forShop(ctx.shop.id);
  const [service, staff] = await Promise.all([
    db.service.findFirst({ where: { id: slot.serviceId, shopId: ctx.shop.id }, select: { name: true } }),
    db.staff.findFirst({ where: { id: slot.staffId, shopId: ctx.shop.id }, select: { name: true } }),
  ]);
  if (!service || !staff) return null;
  const day = dayOf(slot.startsAt, ctx.shop.timezone);
  const r = await tool(actor, now, "check_availability", { service: service.name, from_date: day, to_date: day, barber: staff.name });
  if (!r.ok) return null;
  const hit = flattenSlots(r.data).find((s) => decodeSlotId(s.slot_id)?.startsAt.getTime() === slot.startsAt.getTime());
  return hit ? { service: service.name, barber: staff.name, price: hit.price } : null;
}

function slotPart(slotId: string, timeZone: string): "morning" | "afternoon" | null {
  const s = decodeSlotId(slotId);
  return s ? (zonedMinutesOfDay(s.startsAt, timeZone) < 12 * 60 ? "morning" : "afternoon") : null;
}

function flattenSlots(data: any): Array<{ slot_id: string; label: string; price: number; barber: string }> {
  const out: Array<{ slot_id: string; label: string; price: number; barber: string }> = [];
  for (const b of data?.availability ?? []) for (const s of b.slots ?? []) out.push({ slot_id: s.slot_id, label: s.label, price: Number(s.price), barber: b.barber });
  return out.sort((a, b) => (decodeSlotId(a.slot_id)?.startsAt.getTime() ?? 0) - (decodeSlotId(b.slot_id)?.startsAt.getTime() ?? 0));
}

// ── state the preview was made from ──────────────────────────────────────

interface ApptState {
  id: string;
  shopId: string;
  status: string;
  startsAt: Date;
  staffId: string;
  serviceId: string;
  clientId: string | null;
  holdExpiresAt: Date | null;
  priceAtBooking: { toString(): string } | null;
  manageToken: string;
  service: { name: string };
  staff: { name: string };
}

async function apptState(shopId: string, id: string): Promise<ApptState | null> {
  return runWithShop(shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id, shopId },
      select: {
        id: true,
        shopId: true,
        status: true,
        startsAt: true,
        staffId: true,
        serviceId: true,
        clientId: true,
        holdExpiresAt: true,
        priceAtBooking: true,
        manageToken: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
      },
    }),
  ) as Promise<ApptState | null>;
}

/** What makes two looks at one appointment "the same booking" for a confirm. */
function fingerprint(a: ApptState): string {
  return [a.id, a.status, a.startsAt.toISOString(), a.staffId, a.serviceId, a.priceAtBooking?.toString() ?? ""].join("|");
}

/** What cancelling `apptId` NOW keeps or charges - the receptionist's own quote. */
async function cancelQuote(actor: AssistantActor, apptId: string, now: Date): Promise<{ kept: number; card: number; why: string }> {
  const hist = await tool(actor, now, "get_client_history", {});
  const row = (hist.data?.upcoming_appointments ?? []).find((a: any) => a.appointment_id === apptId) ?? {};
  return { kept: Number(row.if_cancelled_kept_cents ?? 0), card: Number(row.if_cancelled_card_charged_cents ?? 0), why: String(row.if_cancelled_why ?? "") };
}

async function cancelPreview(actor: AssistantActor, ctx: Ctx, own: OwnAppt, now: Date, action: string): Promise<Out> {
  const q = await cancelQuote(actor, own.id, now);
  const fee =
    q.kept > 0
      ? ` ${dollars(q.kept / 100)} of what you paid stays with the shop (${q.why}).`
      : q.card > 0
        ? ` Your card on file will be charged ${dollars(q.card / 100)} (${q.why}).`
        : " No fee.";
  const summary = `Cancel your ${own.serviceName} with ${own.staffName} at ${ctx.shop.name}, ${when(own.startsAt, ctx.shop.timezone)}?${fee}`;
  const state = await apptState(actor.shopId, own.id);
  const token = await mintConfirm(
    {
      actor: actorKey(actor),
      shopId: actor.shopId,
      action: "cancel",
      args: { appointment_id: own.id },
      stateKey: `${fingerprint(state!)}|fee:${q.kept}:${q.card}`,
      summary,
    },
    now,
  );
  return { action, text: summary, choices: [], confirm: { token, summary } };
}

/**
 * Pending Acuity sync, said as it is. A booking is in ChairBack the moment it
 * commits; the block on the barber's Acuity calendar follows (outbox, then the
 * reconciler). Never "it's on the Acuity calendar" until Acuity said so.
 */
async function acuityNote(shopId: string, appointmentId: string): Promise<string> {
  const rows = await runWithShop(shopId, (tx) =>
    tx.acuityOutboundBlock.findMany({ where: { appointmentId }, select: { state: true, releaseRequested: true } }),
  );
  const live = rows.filter((r) => !r.releaseRequested);
  if (live.length === 0) return "";
  if (live.every((r) => r.state === "ACTIVE")) return "";
  if (live.some((r) => r.state === "PENDING" || r.state === "UNKNOWN")) {
    return " It's in ChairBack now; the shop's Acuity calendar is still being updated.";
  }
  return "";
}

// ── a new request replaces the old one ───────────────────────────────────

const REPLACED: ConfirmReply = { ok: false, text: "That was replaced by your newer request, so nothing was changed." };

/**
 * Retire every open preview this person has at this shop, and let go of the
 * time a booking preview was holding. Each row moves pending -> superseded by
 * the SAME compare-and-set a Confirm uses to move it pending -> running, so a
 * Confirm racing this turn either got there first (and runs) or finds the row
 * superseded and changes nothing. Returns what was actually withdrawn.
 */
export async function supersedePending(actor: AssistantActor, now: Date): Promise<Array<{ action: string; summary: string }>> {
  const open = await runAsOwner((tx) =>
    tx.assistantConfirmation.findMany({
      where: { actor: actorKey(actor), shopId: actor.shopId, status: "pending" },
      select: { id: true, action: true, args: true, summary: true },
    }),
  );
  const out: Array<{ action: string; summary: string }> = [];
  let released = false;
  for (const row of open) {
    const won = await runAsOwner((tx) =>
      tx.assistantConfirmation.updateMany({
        where: { id: row.id, status: "pending" },
        data: { status: "superseded", result: REPLACED as unknown as Prisma.InputJsonValue, settledAt: now },
      }),
    );
    if (won.count !== 1) continue;
    out.push({ action: row.action, summary: row.summary });
    const holdId = (row.args as Record<string, unknown>)?.hold_id;
    if (row.action === "book" && typeof holdId === "string" && actor.clientId) {
      // Only OUR hold, only while it is still a hold (holdSweep.ts's flip).
      const r = await runWithShop(actor.shopId, (tx) =>
        tx.appointment.updateMany({
          where: { id: holdId, shopId: actor.shopId, clientId: actor.clientId!, status: "PENDING", holdExpiresAt: { not: null } },
          data: { status: "CANCELED", canceledAt: now },
        }),
      );
      released ||= r.count > 0;
    }
  }
  if (released) await noteAvailabilityChanged(actor.shopId);
  return out;
}

/**
 * "Never mind": what was on the table is gone - or, if it already went
 * through, say THAT, and offer the way back. Never "undone" when it wasn't.
 */
async function neverMind(actor: AssistantActor, ctx: Ctx, superseded: Array<{ action: string; summary: string }>, now: Date): Promise<Out> {
  if (superseded.length) {
    return { action: "never_mind", text: "Okay, I dropped that. Nothing was changed.", choices: menuChoices(actor) };
  }
  // A Confirm that won the row before this message is still RUNNING: it is not
  // "nothing changed" until it settles. Wait a moment for it; if it is still
  // going, say so rather than guess either way.
  const running = () =>
    runAsOwner((tx) => tx.assistantConfirmation.count({ where: { actor: actorKey(actor), shopId: actor.shopId, status: "running" } }));
  for (let i = 0; i < 20 && (await running()) > 0; i++) await new Promise((r) => setTimeout(r, 250));
  if ((await running()) > 0) {
    return {
      action: "never_mind",
      text: "That was already going through when you said that, so I can't stop it here. Check My appointments in a moment to see where it stands.",
      choices: [{ label: "My appointments", pick: pick(actor, "my_appointments", {}) }],
    };
  }
  const recentDone = await runAsOwner((tx) =>
    tx.assistantConfirmation.findFirst({
      where: { actor: actorKey(actor), shopId: actor.shopId, status: "done", settledAt: { gte: new Date(now.getTime() - 30 * 60 * 1000) } },
      orderBy: { settledAt: "desc" },
      select: { action: true, args: true, summary: true, result: true },
    }),
  );
  if (recentDone && (recentDone.result as { ok?: boolean } | null)?.ok) {
    const a = recentDone.args as Record<string, unknown>;
    const what = recentDone.summary.replace(/\?$/, "");
    if (recentDone.action === "book" || recentDone.action === "move") {
      const apptId = String(recentDone.action === "book" ? a.hold_id : a.appointment_id);
      const still = await ownAppointment(actor, ctx, apptId, now);
      return {
        action: "never_mind",
        text: `That already went through (${what}), so I haven't undone anything.${still ? " Do you want to cancel it?" : ""}`,
        choices: still ? [{ label: `Cancel ${still.label}`, pick: pick(actor, "pick_cancel", { appointment_id: still.id }) }] : [],
      };
    }
    if (recentDone.action === "cancel") {
      return {
        action: "never_mind",
        text: "That cancellation already went through, and I can't undo it here. You can book that time again if it's still free.",
        choices: [{ label: "Book", pick: pick(actor, "book_start", {}) }],
      };
    }
  }
  return { action: "never_mind", text: "Okay. Nothing was changed. Anything else?", choices: menuChoices(actor) };
}

function menuChoices(actor: AssistantActor): Choice[] {
  return [
    { label: "Book", pick: pick(actor, "book_start", {}) },
    { label: "My appointments", pick: pick(actor, "my_appointments", {}) },
    { label: "Reschedule", pick: pick(actor, "move_start", {}) },
    { label: "Cancel", pick: pick(actor, "cancel_start", {}) },
    { label: "Ask the shop", pick: pick(actor, "ask_shop", {}) },
  ];
}

/** Seven day buttons from `from` (today by default), as the shop's calendar names them. */
function nextDays(ctx: Ctx, from = ctx.today): Array<{ date: string; label: string }> {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const label =
      date === ctx.today
        ? "Today"
        : date === addDays(ctx.today, 1)
          ? "Tomorrow"
          : new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    return { date, label };
  });
}

/** How far "Later dates" pages: eight weeks. */
const DAY_PAGES = 8;
function laterFrom(ctx: Ctx, from: string): string | null {
  const next = addDays(from, 7);
  return next < addDays(ctx.today, 7 * DAY_PAGES) ? next : null;
}

/**
 * The day buttons for a move, a week at a time, with "Later dates" (a booking
 * or move more than a week out was once unreachable by buttons).
 */
function moveDayChoices(actor: AssistantActor, ctx: Ctx, appointmentId: string, from: string, part?: "morning" | "afternoon"): Choice[] {
  const later = laterFrom(ctx, from);
  return [
    ...nextDays(ctx, from).map((d) => ({ label: d.label, pick: pick(actor, "move_day", { appointment_id: appointmentId, date: d.date, ...(part ? { part } : {}) }) })),
    ...(later ? [{ label: "Later dates", pick: pick(actor, "pick_move", { appointment_id: appointmentId, from: later }) }] : []),
  ];
}

// ── confirm: the person's tap ────────────────────────────────────────────

export interface ConfirmReply {
  ok: boolean;
  text: string;
  /** True when this answer is the replay of an earlier tap on the same token. */
  replay?: boolean;
  /** Someone (another tap, another instance) is running it right now. */
  pending?: boolean;
  /** A new question to confirm: something material changed since the preview. */
  confirm?: { token: string; summary: string };
  /** For the screen's link to the booking, when there is one. */
  appointmentId?: string;
}

type Redeemed = { status: "done" | "failed" | "superseded"; reply: ConfirmReply };

export async function runConfirm(actor: AssistantActor, token: string, now = new Date()): Promise<ConfirmReply> {
  const loaded = await loadConfirm(token, { actor: actorKey(actor), shopId: actor.shopId }, now);
  if (!loaded.ok) {
    return loaded.reason === "expired"
      ? { ok: false, text: "That confirmation timed out. Ask again and I'll check the time is still free." }
      : { ok: false, text: "That confirmation isn't valid." };
  }
  const row = loaded.row;
  const claim = await claimConfirm(row.id, now);
  if (claim.kind === "settled") return { ...(claim.row.result as ConfirmReply), replay: true };
  if (claim.kind === "busy") return { ok: false, pending: true, text: "Still working on that one. Check again in a moment." };
  if (claim.kind === "expired") return { ok: false, text: "That confirmation timed out. Ask again and I'll check the time is still free." };
  try {
    const ctx = await loadContext(actor, now);
    const r = await redeem(actor, ctx, row, now);
    await settleConfirm(row.id, r.status, r.reply, now);
    return r.reply;
  } catch (err) {
    logger.error({ err, action: row.action }, "assistant: confirm failed");
    // Back to pending: the next tap starts by checking whether the change
    // already happened, so a crash after the write cannot make it happen twice.
    await releaseConfirm(row.id);
    return { ok: false, text: "Something went wrong. Tap confirm again to retry; nothing will happen twice." };
  }
}

/** The receipt, read back from the SAVED row: what the database says, never the preview's words. */
function receipt(ctx: Ctx, verb: "Booked" | "Moved", a: ApptState): string {
  const price = a.priceAtBooking === null ? "" : `, ${dollars(Number(a.priceAtBooking.toString()))}`;
  return `${verb}: ${a.service.name} with ${a.staff.name} at ${ctx.shop.name}, ${when(a.startsAt, ctx.shop.timezone)}${price}.`;
}

/**
 * Run one confirmation. ALWAYS in this order:
 *   1. already applied? (a lost response, a restart mid-run, another instance)
 *      -> report it, change nothing;
 *   2. still the state the preview showed, at the price it showed?
 *      -> if not, a NEW preview with what is true now;
 *   3. do it through the booking engine, and believe only what the database
 *      then says.
 */
async function redeem(actor: AssistantActor, ctx: Ctx, row: ConfirmRow, now: Date): Promise<Redeemed> {
  const args = row.args;
  const done = (reply: ConfirmReply): Redeemed => ({ status: "done", reply });
  const failed = (text: string): Redeemed => ({ status: "failed", reply: { ok: false, text } });

  if (row.action === "book") {
    const hold = await apptState(actor.shopId, String(args.hold_id));
    // 1. Already booked by this very confirmation (or its lost first answer).
    if (hold && hold.status === "BOOKED" && hold.clientId === actor.clientId) {
      void notifyAppointmentConfirmation({ shopId: actor.shopId, appointmentId: hold.id });
      return done({ ok: true, appointmentId: hold.id, text: `${receipt(ctx, "Booked", hold)}${await acuityNote(actor.shopId, hold.id)}` });
    }
    if (actor.ambiguous || !actor.clientId) return failed("I can't book from chat for you here. Use the booking page.");
    const slot = decodeSlotId(String(args.slot_id));
    if (!slot) return failed("That time is no longer valid. Ask again for fresh times.");
    // The shop's rules AGAIN, at the moment of booking: a shop can switch on
    // approval, a policy, a required question or a deposit - or lapse - between
    // the preview and the tap. Nothing is booked; the hold lapses on its own.
    const prefill = { serviceId: slot.serviceId, staffId: slot.staffId };
    const gate = bookingGate(actor, ctx, now, prefill);
    if (gate) return { status: "failed", reply: { ok: false, text: `Nothing was booked. ${gate.text}` } };
    if (await needsIntake(actor.shopId, slot.serviceId)) {
      return failed("Nothing was booked. This service now has questions to answer first, so finish on the booking page.");
    }
    // 2a. The hold lapsed or was taken: offer it again if it is still free.
    const holdLive = hold && hold.status === "PENDING" && hold.holdExpiresAt && hold.holdExpiresAt > now && hold.clientId === actor.clientId;
    if (!holdLive) {
      const again = await execute(actor, ctx, "pick_slot", { slot_id: String(args.slot_id) }, now);
      return again.confirm
        ? { status: "superseded", reply: { ok: false, text: `Your hold on that time ran out, so I held it again. ${again.confirm.summary}`, confirm: again.confirm } }
        : failed("That time is gone now, so nothing was booked. Ask again for fresh times.");
    }
    // 2b. The price the preview showed must be the price the engine WILL write.
    // Booking a held slot keeps the price stored ON THE HOLD (locked when it
    // was made - receptionist/tools.ts bookAppointment), not today's list
    // price. Comparing against the list price once told a customer "now $25"
    // and then booked $20. The hold is the truth.
    const price = hold.priceAtBooking === null ? null : Math.round(Number(hold.priceAtBooking.toString()) * 100);
    if (price !== null && price !== Number(args.price_cents)) {
      const summary = `The price for that time is now ${dollars(price / 100)} (it was ${dollars(Number(args.price_cents) / 100)}). ${bookSummary(ctx, hold.service.name, hold.staff.name, slot.startsAt, price)}`;
      const token = await mintConfirm(
        { actor: actorKey(actor), shopId: actor.shopId, action: "book", args: { ...args, price_cents: price }, stateKey: `hold:${hold.id}|${slot.startsAt.toISOString()}|${slot.staffId}|${price}`, summary },
        now,
      );
      return { status: "superseded", reply: { ok: false, text: summary, confirm: { token, summary } } };
    }
    // 3. Book, then believe the database.
    const r = await tool(actor, now, "book_appointment", { slot_id: String(args.slot_id) });
    const after = r.ok ? await apptState(actor.shopId, String(r.data?.appointment_id ?? hold.id)) : null;
    if (!after || after.status !== "BOOKED") return failed("That time is gone now, so nothing was booked. Ask again for fresh times.");
    void notifyAppointmentConfirmation({ shopId: actor.shopId, appointmentId: after.id });
    void notifyBarberBookingEvent({ shopId: actor.shopId, appointmentId: after.id, kind: "booked" });
    return done({ ok: true, appointmentId: after.id, text: `${receipt(ctx, "Booked", after)}${await acuityNote(actor.shopId, after.id)}` });
  }

  if (row.action === "move") {
    const appt = await apptState(actor.shopId, String(args.appointment_id));
    const slot = decodeSlotId(String(args.slot_id));
    if (!appt || !slot || appt.clientId !== actor.clientId) return failed("I couldn't find that appointment.");
    if (appt.status === "BOOKED" && appt.startsAt.getTime() === slot.startsAt.getTime() && appt.staffId === slot.staffId) {
      return done({ ok: true, appointmentId: appt.id, text: `${receipt(ctx, "Moved", appt)}${await acuityNote(actor.shopId, appt.id)}` });
    }
    if (actor.ambiguous) return failed("I can't change bookings from chat for you here.");
    const off = lapsed(ctx, "move", now);
    if (off) return failed(`Nothing was moved. ${off.text}`);
    if (!row.stateKey.startsWith(`${fingerprint(appt)}|`)) {
      if (appt.status !== "BOOKED" || appt.startsAt <= now) return failed("That appointment has changed since, so nothing was moved.");
      const own = await ownAppointment(actor, ctx, appt.id, now);
      const again = own ? await execute(actor, ctx, "pick_new_slot", { appointment_id: appt.id, slot_id: String(args.slot_id) }, now) : null;
      return again?.confirm
        ? { status: "superseded", reply: { ok: false, text: `That appointment changed since you asked. ${again.confirm.summary}`, confirm: again.confirm } }
        : failed("That appointment changed since you asked, and that time isn't open any more. Nothing was moved.");
    }
    const r = await tool(actor, now, "reschedule", { appointment_id: appt.id, new_slot_id: String(args.slot_id), accept_price_cents: Number(args.price_cents) });
    if (r.ok && r.data?.needs_price_ok) {
      const summary = `Moving it changes the price to ${r.data.new_price} (${r.data.reason}). Move it at that price?`;
      const token = await mintConfirm(
        { actor: actorKey(actor), shopId: actor.shopId, action: "move", args: { ...args, price_cents: Number(r.data.new_price_cents) }, stateKey: row.stateKey, summary },
        now,
      );
      return { status: "superseded", reply: { ok: false, text: summary, confirm: { token, summary } } };
    }
    const after = await apptState(actor.shopId, appt.id);
    if (!r.ok || !after || after.startsAt.getTime() !== slot.startsAt.getTime()) {
      return failed("That move didn't go through and your appointment is unchanged. Ask again for fresh times.");
    }
    void notifyAppointmentConfirmation({ shopId: actor.shopId, appointmentId: after.id, moved: true });
    void notifyBarberBookingEvent({ shopId: actor.shopId, appointmentId: after.id, kind: "rescheduled" });
    return done({ ok: true, appointmentId: after.id, text: `${receipt(ctx, "Moved", after)}${await acuityNote(actor.shopId, after.id)}` });
  }

  if (row.action === "cancel") {
    const appt = await apptState(actor.shopId, String(args.appointment_id));
    if (!appt || appt.clientId !== actor.clientId) return failed("I couldn't find that appointment.");
    const what = `${appt.service.name} with ${appt.staff.name} at ${ctx.shop.name}, ${when(appt.startsAt, ctx.shop.timezone)}`;
    if (appt.status === "CANCELED") return done({ ok: true, text: `Cancelled: ${what}.` });
    if (actor.ambiguous) return failed("I can't change bookings from chat for you here.");
    const q = await cancelQuote(actor, appt.id, now);
    if (row.stateKey !== `${fingerprint(appt)}|fee:${q.kept}:${q.card}`) {
      const own = await ownAppointment(actor, ctx, appt.id, now);
      if (!own) return failed("That appointment has changed since, so nothing was cancelled.");
      const again = await cancelPreview(actor, ctx, own, now, "pick_cancel");
      return { status: "superseded", reply: { ok: false, text: `Something changed since you asked. ${again.confirm!.summary}`, confirm: again.confirm } };
    }
    const r = await tool(actor, now, "cancel", { appointment_id: appt.id });
    const after = await apptState(actor.shopId, appt.id);
    if (!r.ok || after?.status !== "CANCELED") return failed("That couldn't be cancelled from here, and nothing changed.");
    void notifyBarberBookingEvent({ shopId: actor.shopId, appointmentId: appt.id, kind: "canceled" });
    return done({ ok: true, text: `Cancelled: ${what}.` });
  }

  return failed("That confirmation isn't valid.");
}
