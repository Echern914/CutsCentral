import type { Request } from "express";
import { zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { computeOpenSlots } from "../engines/slots.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import {
  cancelAppointmentCore,
  createAppointmentCore,
  rescheduleAppointmentCore,
  type DashboardWriteReq,
  type DashboardWriteRes,
} from "../routes/booking.dashboard.js";
import { claimConfirm, loadConfirm, mintConfirm, readPick, releaseConfirm, settleConfirm, signPick, type ConfirmRow } from "./confirm.js";
import { addDays } from "./guided.js";
import { barberIntent, timeOfDay } from "./barberRules.js";

/**
 * 🔴 THE BARBER'S BOOKING CHAT: run the day from the help bubble. A menu of
 * buttons plus typed shortcuts the server's rules read (barberRules.ts) - no
 * model, no outside service, nothing that costs money.
 *
 *  - Reads: the day's agenda, a client lookup, open times (computeOpenSlots,
 *    exactly as the dashboard's own time picker calls it).
 *  - Writes: book, move, cancel - each a PREVIEW first, then a Confirm token
 *    (confirm.ts, the same once-only state machine as the customer chat), and
 *    each runs the DASHBOARD'S OWN handler (createAppointmentCore,
 *    rescheduleAppointmentCore, cancelAppointmentCore). The chat never has its
 *    own rules for what may be booked, so it cannot drift from the calendar.
 *
 * WHO SEES WHAT. An owner or manager sees and changes the whole shop. A staff
 * barber (BARBER seat) sees and changes ONLY their own column: their chair
 * comes from their seat (`req.shopStaffId`), never from anything typed or
 * tapped, and every write re-checks it at confirm time.
 */

export type BarberRole = "OWNER" | "MANAGER" | "BARBER";

export interface BarberActor {
  userId: string;
  shopId: string;
  role: BarberRole;
  /** The seat's own chair. Required for a BARBER seat (their whole scope). */
  chairId: string | null;
  /** What the dashboard's write handlers read from a request - passed through unchanged. */
  write: { shop: Request["shop"]; userId: string; shopStaffId: string | null };
}

export interface BarberChoice {
  label: string;
  pick: string;
}

export interface BarberReply {
  /** False: the message wasn't a scheduling request - the bubble answers it as a help question. */
  handled: boolean;
  text: string;
  choices: BarberChoice[];
  confirm?: { token: string; summary: string };
}

export interface BarberConfirmReply {
  ok: boolean;
  text: string;
  replay?: boolean;
  pending?: boolean;
  confirm?: { token: string; summary: string };
}

const chairOnly = (a: BarberActor) => a.role === "BARBER";
const actorKey = (a: BarberActor) => `u:${a.userId}`;
const reply = (text: string, choices: BarberChoice[] = [], extra: Partial<BarberReply> = {}): BarberReply => ({
  handled: true,
  text,
  choices,
  ...extra,
});
const NOT_HANDLED: BarberReply = { handled: false, text: "", choices: [] };

// ── context ───────────────────────────────────────────────────────────────

interface Ctx {
  shop: { id: string; name: string; timezone: string; bookingMode: string };
  today: string;
  staff: { id: string; name: string }[];
  services: { id: string; name: string; price: number | null; staffIds: string[] }[];
}

async function loadCtx(actor: BarberActor, now: Date): Promise<Ctx> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: actor.shopId },
    select: { id: true, name: true, timezone: true, bookingMode: true },
  });
  // runWithShop, not forShop: the forShop facade types findMany as the FULL row whatever is selected.
  const [staff, services] = await runWithShop(shop.id, (tx) => Promise.all([
    tx.staff.findMany({ where: { shopId: shop.id, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    tx.service.findMany({
      where: { shopId: shop.id, active: true },
      select: { id: true, name: true, price: true, staff: { select: { staffId: true } } },
      orderBy: { name: "asc" },
    }),
  ]));
  return {
    shop: { ...shop, bookingMode: String(shop.bookingMode) },
    today: dayKey(now, shop.timezone),
    staff,
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      price: s.price === null ? null : Number(s.price),
      staffIds: s.staff.map((x) => x.staffId),
    })),
  };
}

// ── time ──────────────────────────────────────────────────────────────────

function dayKey(at: Date, tz: string): string {
  const p = zonedDateParts(at, tz);
  return new Date(Date.UTC(p.year, p.month0, p.day)).toISOString().slice(0, 10);
}
function dayRange(day: string, tz: string): { from: Date; to: Date } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { from: zonedWallTimeToUtc(y, m - 1, d, 0, tz), to: zonedWallTimeToUtc(y, m - 1, d + 1, 0, tz) };
}
/** One shop-local day as the slot engine takes it - from now if the day has begun (as the booking page asks). */
function daySpan(day: string, tz: string, now: Date): { fromDate: Date; toDate: Date } {
  const { from, to } = dayRange(day, tz);
  return { fromDate: from.getTime() > now.getTime() ? from : now, toDate: to };
}
function fmt(at: Date, tz: string, parts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...parts }).format(at);
  } catch {
    return at.toISOString();
  }
}
const clock = (at: Date, tz: string) => fmt(at, tz, { hour: "numeric", minute: "2-digit" });
const when = (at: Date, tz: string) =>
  `${fmt(at, tz, { weekday: "short", month: "short", day: "numeric" })} at ${fmt(at, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
function dayLabel(day: string, ctx: Ctx): string {
  if (day === ctx.today) return "Today";
  if (day === addDays(ctx.today, 1)) return "Tomorrow";
  return fmt(new Date(`${day}T12:00:00Z`), "UTC", { weekday: "short", month: "short", day: "numeric" });
}
const money = (n: number | null) => (n === null ? "" : `, $${Number.isInteger(n) ? n : n.toFixed(2)}`);
const fullName = (f: string | null, l: string | null) => [f, l].filter(Boolean).join(" ").trim() || "A client";

// ── picks (signed buttons) ────────────────────────────────────────────────

function pick(actor: BarberActor, name: string, args: Record<string, string>): string {
  return signPick({ actor: actorKey(actor), shopId: actor.shopId, name, args });
}

function menu(actor: BarberActor): BarberChoice[] {
  return [
    { label: "Today", pick: pick(actor, "day", { date: "today" }) },
    { label: "Tomorrow", pick: pick(actor, "day", { date: "tomorrow" }) },
    { label: "Book a client", pick: pick(actor, "book_start", {}) },
    { label: "Move an appointment", pick: pick(actor, "upcoming", { op: "move" }) },
    { label: "Cancel an appointment", pick: pick(actor, "upcoming", { op: "cancel" }) },
  ];
}

// ── reads ─────────────────────────────────────────────────────────────────

interface Appt {
  id: string;
  startsAt: Date;
  status: string;
  staffId: string | null;
  firstName: string;
  lastName: string | null;
  service: string;
  barber: string;
}

/** Native appointments in scope between two instants: no cancels or no-shows, no checkout/receptionist holds. */
async function appointmentsBetween(actor: BarberActor, from: Date, to: Date, take = 60): Promise<Appt[]> {
  const rows = await runWithShop(actor.shopId, (tx) =>
    tx.appointment.findMany({
      where: {
        shopId: actor.shopId,
        status: { in: ["BOOKED", "COMPLETED", "PENDING"] },
        holdExpiresAt: null,
        startsAt: { gte: from, lt: to },
        ...(chairOnly(actor) ? { staffId: actor.chairId! } : {}),
      },
      orderBy: { startsAt: "asc" },
      take,
      select: {
        id: true,
        startsAt: true,
        status: true,
        staffId: true,
        firstName: true,
        lastName: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
      },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt,
    status: String(r.status),
    staffId: r.staffId,
    firstName: r.firstName,
    lastName: r.lastName,
    service: r.service?.name ?? "Appointment",
    barber: r.staff?.name ?? "",
  }));
}

/** One appointment the actor may CHANGE: in scope, booked, and still ahead. */
async function changeable(actor: BarberActor, id: string, now: Date) {
  const a = await runWithShop(actor.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id, shopId: actor.shopId, ...(chairOnly(actor) ? { staffId: actor.chairId! } : {}) },
      select: {
        id: true,
        startsAt: true,
        status: true,
        staffId: true,
        serviceId: true,
        firstName: true,
        lastName: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
      },
    }),
  );
  if (!a || a.status !== "BOOKED" || a.startsAt <= now || !a.staffId) return null;
  return a;
}

async function showDay(actor: BarberActor, ctx: Ctx, day: string, now: Date): Promise<BarberReply> {
  const tz = ctx.shop.timezone;
  const { from, to } = dayRange(day, tz);
  const appts = await appointmentsBetween(actor, from, to);
  // Bookings synced from Acuity/Square record no chair, so only a shop-wide
  // view can show them honestly (the MCP agenda's rule, for the same reason).
  const synced = chairOnly(actor)
    ? []
    : await runWithShop(actor.shopId, (tx) =>
        tx.visit.findMany({
          where: { shopId: actor.shopId, appointment: null, scheduledAt: { gte: from, lt: to } },
          orderBy: { scheduledAt: "asc" },
          take: 60,
          select: { scheduledAt: true, serviceName: true, status: true, client: { select: { firstName: true, lastName: true } } },
        }),
      );
  const syncedLive = synced.filter((v) => !/cancel|no_?show/i.test(String(v.status)));
  const multiChair = !chairOnly(actor) && ctx.staff.length > 1;
  const lines = [
    ...appts.map((a) => ({
      at: a.startsAt,
      text: `${clock(a.startsAt, tz)}  ${fullName(a.firstName, a.lastName)} - ${a.service}${multiChair && a.barber ? ` (${a.barber})` : ""}${a.status === "PENDING" ? " - request" : a.status === "COMPLETED" ? " - done" : ""}`,
    })),
    ...syncedLive.map((v) => ({
      at: v.scheduledAt,
      text: `${clock(v.scheduledAt, tz)}  ${fullName(v.client?.firstName ?? null, v.client?.lastName ?? null)} - ${v.serviceName ?? "Appointment"} (synced)`,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const label = dayLabel(day, ctx);
  const confirmed = appts.filter((a) => a.status !== "PENDING").length + syncedLive.length;
  const requested = appts.filter((a) => a.status === "PENDING").length;
  const head =
    lines.length === 0
      ? `${label}: nothing booked.`
      : `${label}: ${confirmed} ${confirmed === 1 ? "appointment" : "appointments"}${requested ? `, ${requested} ${requested === 1 ? "request" : "requests"}` : ""}.`;
  const choices: BarberChoice[] = appts
    .filter((a) => a.status === "BOOKED" && a.startsAt > now)
    .slice(0, 8)
    .map((a) => ({ label: `${clock(a.startsAt, tz)} ${fullName(a.firstName, a.lastName)}`, pick: pick(actor, "appt", { id: a.id }) }));
  choices.push(
    { label: "Previous day", pick: pick(actor, "day", { date: addDays(day, -1) }) },
    { label: "Next day", pick: pick(actor, "day", { date: addDays(day, 1) }) },
  );
  return reply([head, ...lines.map((l) => l.text)].join("\n"), choices);
}

/** Clients whose name matches every word typed. A staff barber searches only their own clientele. */
async function findClients(actor: BarberActor, name: string) {
  const words = name.split(/\s+/).filter(Boolean).slice(0, 3);
  const rows = await runWithShop(actor.shopId, (tx) =>
    tx.client.findMany({
      where: {
        shopId: actor.shopId,
        NOT: { acuityClientKey: { startsWith: "deleted:" } },
        AND: words.map((w) => ({
          OR: [{ firstName: { contains: w, mode: "insensitive" as const } }, { lastName: { contains: w, mode: "insensitive" as const } }],
        })),
        ...(chairOnly(actor)
          ? { appointments: { some: { staffId: actor.chairId!, status: { in: ["BOOKED", "COMPLETED"] } } } }
          : {}),
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 7,
      select: { id: true, firstName: true, lastName: true, phone: true },
    }),
  );
  return rows.map((c) => ({
    id: c.id,
    name: fullName(c.firstName, c.lastName),
    // Masked, like the barber's own client list: enough to tell two Mikes apart.
    label: `${fullName(c.firstName, c.lastName)}${c.phone ? ` · ··· ${c.phone.replace(/\D/g, "").slice(-4)}` : ""}`,
  }));
}

// ── the book flow ─────────────────────────────────────────────────────────

/** Who the booking is for, as it rides along in the buttons. */
type ClientArgs = { clientId: string; who: string } | { first: string; last: string; who: string };

function clientArgs(a: Record<string, string>): ClientArgs | null {
  if (a.clientId && a.who) return { clientId: a.clientId, who: a.who };
  if (a.first && a.who) return { first: a.first, last: a.last ?? "", who: a.who };
  return null;
}

function servicesFor(actor: BarberActor, ctx: Ctx) {
  return chairOnly(actor) ? ctx.services.filter((s) => s.staffIds.includes(actor.chairId!)) : ctx.services;
}

async function bookChooseClient(actor: BarberActor, name: string, carry: Record<string, string>): Promise<BarberReply> {
  const found = await findClients(actor, name);
  const parts = name.split(/\s+/);
  const asNew = {
    label: `New client: ${name.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    pick: pick(actor, "book_service", {
      ...carry,
      first: parts[0]!.replace(/^\w/, (c) => c.toUpperCase()),
      last: parts.slice(1).join(" ").replace(/\b\w/g, (c) => c.toUpperCase()),
      who: name.replace(/\b\w/g, (c) => c.toUpperCase()),
    }),
  };
  if (found.length === 0) {
    return reply(`I couldn't find a client named "${name}"${chairOnly(actor) ? " in your clients" : ""}. Book them as a new client?`, [asNew]);
  }
  return reply(
    found.length === 1 ? `Book ${found[0]!.name}?` : `Which ${name}?`,
    [
      ...found.slice(0, 6).map((c) => ({ label: c.label, pick: pick(actor, "book_service", { ...carry, clientId: c.id, who: c.name }) })),
      asNew,
    ],
  );
}

async function bookChooseService(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  const client = clientArgs(args);
  if (!client) return reply("Who is the booking for? Type their name.", []);
  const offered = servicesFor(actor, ctx);
  const preset = args.serviceId ? offered.find((s) => s.id === args.serviceId) : undefined;
  if (preset) return bookChooseBarber(actor, ctx, { ...args, serviceId: preset.id }, now);
  if (offered.length === 0) return reply("There are no services you can book yet. Add one under Services.", []);
  return reply(
    `What is ${client.who} booking?`,
    offered.slice(0, 12).map((s) => ({ label: `${s.name}${money(s.price)}`, pick: pick(actor, "book_barber", { ...args, serviceId: s.id }) })),
  );
}

async function bookChooseBarber(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  const service = ctx.services.find((s) => s.id === args.serviceId);
  if (!service) return reply("That service isn't on the menu any more.", []);
  if (chairOnly(actor)) return bookChooseDay(actor, ctx, { ...args, staffId: actor.chairId! }, now);
  const who = ctx.staff.filter((s) => service.staffIds.includes(s.id));
  if (who.length === 0) return reply(`Nobody offers ${service.name} right now. Add a barber to it under Services.`, []);
  if (who.length === 1) return bookChooseDay(actor, ctx, { ...args, staffId: who[0]!.id }, now);
  // The person asking first, when they have a chair and do this service.
  const ordered = [...who].sort((a, b) => Number(b.id === actor.chairId) - Number(a.id === actor.chairId));
  return reply(`With who?`, ordered.map((s) => ({ label: s.name, pick: pick(actor, "book_day", { ...args, staffId: s.id }) })));
}

async function bookChooseDay(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  // A day already named ("book Jordan friday") goes straight to its times.
  if (args.date && !args.from) return bookChooseTime(actor, ctx, args, now);
  const from = args.from ?? ctx.today;
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return reply("Which day?", [
    ...days.map((d) => ({ label: dayLabel(d, ctx), pick: pick(actor, "book_time", { ...args, date: d }) })),
    { label: "Later", pick: pick(actor, "book_day", { ...args, from: addDays(from, 7) }) },
  ]);
}

async function bookChooseTime(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  if (ctx.shop.bookingMode !== "native") {
    return reply("Booking from chat needs ChairBack booking switched on for this shop. Book this one from your calendar.", []);
  }
  const { staffId, serviceId, date } = args;
  if (!staffId || !serviceId || !date) return reply("Let's start that booking again.", menu(actor));
  const tz = ctx.shop.timezone;
  const slots = await computeOpenSlots({ shopId: actor.shopId, staffId, serviceId, ...daySpan(date, tz, now), now });
  if (slots.length === 0) {
    return reply(`Nothing open ${dayLabel(date, ctx).toLowerCase() === "today" ? "today" : `on ${dayLabel(date, ctx)}`}. Pick another day:`, [
      ...Array.from({ length: 6 }, (_, i) => addDays(date, i + 1)).map((d) => ({ label: dayLabel(d, ctx), pick: pick(actor, "book_time", { ...args, date: d }) })),
    ]);
  }
  return reply(
    `Open times ${dayLabel(date, ctx) === "Today" ? "today" : `on ${dayLabel(date, ctx)}`}:`,
    slots.slice(0, 12).map((s) => ({ label: clock(s.startsAt, tz), pick: pick(actor, "book_go", { ...args, startsAt: s.startsAt.toISOString() }) })),
  );
}

async function bookPreview(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  const client = clientArgs(args);
  const service = ctx.services.find((s) => s.id === args.serviceId);
  const barber = ctx.staff.find((s) => s.id === args.staffId);
  const startsAt = args.startsAt ? new Date(args.startsAt) : null;
  if (!client || !service || !barber || !startsAt || Number.isNaN(startsAt.getTime())) return reply("Let's start that booking again.", menu(actor));
  if (chairOnly(actor) && barber.id !== actor.chairId) return reply("You can only book on your own calendar.", []);
  const summary = `Book ${client.who} for ${service.name} with ${barber.name}, ${when(startsAt, ctx.shop.timezone)}${money(service.price)}?`;
  const token = await mintConfirm(
    {
      actor: actorKey(actor),
      shopId: actor.shopId,
      action: "book",
      args: {
        staffId: barber.id,
        serviceId: service.id,
        startsAt: startsAt.toISOString(),
        ...("clientId" in client ? { clientId: client.clientId } : { first: client.first, last: client.last }),
        who: client.who,
      },
      stateKey: `book|${barber.id}|${startsAt.toISOString()}`,
      summary,
    },
    now,
  );
  return reply(summary, [], { confirm: { token, summary } });
}

// ── move / cancel ─────────────────────────────────────────────────────────

async function upcoming(actor: BarberActor, ctx: Ctx, op: "move" | "cancel", now: Date, filter?: { name: string | null; date: string | null; minutes: number | null }) {
  const tz = ctx.shop.timezone;
  const from = filter?.date ? dayRange(filter.date, tz).from : now;
  const to = filter?.date ? dayRange(filter.date, tz).to : new Date(now.getTime() + 60 * 86_400_000);
  let list = (await appointmentsBetween(actor, from < now ? now : from, to, 100)).filter((a) => a.status === "BOOKED");
  if (filter?.name) {
    const words = filter.name.toLowerCase().split(/\s+/);
    list = list.filter((a) => words.every((w) => `${a.firstName} ${a.lastName ?? ""}`.toLowerCase().includes(w)));
  }
  if (filter?.minutes !== null && filter?.minutes !== undefined) {
    const m = filter.minutes;
    list = list.filter((a) => {
      const hm = fmt(a.startsAt, tz, { hour: "numeric", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
      return (hm[0]! % 24) * 60 + hm[1]! === m;
    });
  }
  return list;
}

function apptLabel(a: { startsAt: Date; firstName: string; lastName: string | null }, ctx: Ctx) {
  return `${fullName(a.firstName, a.lastName)}, ${fmt(a.startsAt, ctx.shop.timezone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

async function pickAppointment(actor: BarberActor, ctx: Ctx, op: "move" | "cancel", now: Date, filter?: { name: string | null; date: string | null; minutes: number | null }): Promise<BarberReply> {
  const list = await upcoming(actor, ctx, op, now, filter);
  const verb = op === "move" ? "move" : "cancel";
  if (list.length === 1) return op === "move" ? moveChooseDay(actor, ctx, { id: list[0]!.id }, now) : cancelPreview(actor, ctx, list[0]!.id, now);
  if (list.length === 0) {
    const all = filter ? await upcoming(actor, ctx, op, now) : [];
    return reply(
      filter ? `I couldn't find that appointment. Which one do you want to ${verb}?` : "You have nothing coming up.",
      all.slice(0, 8).map((a) => ({ label: apptLabel(a, ctx), pick: pick(actor, op === "move" ? "move_day" : "cancel", { id: a.id }) })),
    );
  }
  return reply(
    `Which one do you want to ${verb}?`,
    list.slice(0, 8).map((a) => ({ label: apptLabel(a, ctx), pick: pick(actor, op === "move" ? "move_day" : "cancel", { id: a.id }) })),
  );
}

async function moveChooseDay(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  const a = await changeable(actor, String(args.id), now);
  if (!a) return reply("That appointment can't be moved any more.", []);
  const from = args.from ?? ctx.today;
  return reply(`Move ${apptLabel(a, ctx)} to which day?`, [
    ...Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => ({ label: dayLabel(d, ctx), pick: pick(actor, "move_time", { id: a.id, date: d }) })),
    { label: "Later", pick: pick(actor, "move_day", { id: a.id, from: addDays(from, 7) }) },
  ]);
}

async function moveChooseTime(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date): Promise<BarberReply> {
  const a = await changeable(actor, String(args.id), now);
  if (!a) return reply("That appointment can't be moved any more.", []);
  const date = String(args.date);
  // The appointment's own time counts as free - it is the one moving.
  const slots = (
    await computeOpenSlots({ shopId: actor.shopId, staffId: a.staffId!, serviceId: a.serviceId, ...daySpan(date, ctx.shop.timezone, now), now, excludeAppointmentId: a.id })
  ).filter((s) => s.startsAt.getTime() !== a.startsAt.getTime());
  if (slots.length === 0) {
    return reply(`Nothing open on ${dayLabel(date, ctx)}. Pick another day:`, [
      ...Array.from({ length: 6 }, (_, i) => addDays(date, i + 1)).map((d) => ({ label: dayLabel(d, ctx), pick: pick(actor, "move_time", { id: a.id, date: d }) })),
    ]);
  }
  return reply(
    `Open times on ${dayLabel(date, ctx)}:`,
    slots.slice(0, 12).map((s) => ({ label: clock(s.startsAt, ctx.shop.timezone), pick: pick(actor, "move_go", { id: a.id, startsAt: s.startsAt.toISOString() }) })),
  );
}

const fingerprint = (a: { startsAt: Date; status: string; staffId: string | null }) => `${a.startsAt.toISOString()}|${a.status}|${a.staffId}`;

async function movePreview(actor: BarberActor, ctx: Ctx, args: Record<string, string>, now: Date, acceptPriceCents?: number): Promise<BarberReply> {
  const a = await changeable(actor, String(args.id), now);
  const to = args.startsAt ? new Date(args.startsAt) : null;
  if (!a || !to || Number.isNaN(to.getTime())) return reply("That appointment can't be moved any more.", []);
  const tz = ctx.shop.timezone;
  const summary = `Move ${fullName(a.firstName, a.lastName)}'s ${a.service?.name ?? "appointment"} from ${when(a.startsAt, tz)} to ${when(to, tz)}?`;
  const token = await mintConfirm(
    {
      actor: actorKey(actor),
      shopId: actor.shopId,
      action: "move",
      args: { appointmentId: a.id, startsAt: to.toISOString(), ...(acceptPriceCents !== undefined ? { acceptPriceCents } : {}) },
      stateKey: fingerprint({ ...a, status: String(a.status) }),
      summary,
    },
    now,
  );
  return reply(summary, [], { confirm: { token, summary } });
}

async function cancelPreview(actor: BarberActor, ctx: Ctx, id: string, now: Date): Promise<BarberReply> {
  const a = await changeable(actor, id, now);
  if (!a) return reply("That appointment can't be cancelled any more.", []);
  const summary = `Cancel ${fullName(a.firstName, a.lastName)}'s ${a.service?.name ?? "appointment"}, ${when(a.startsAt, ctx.shop.timezone)}? They'll get the usual cancellation email, and anything they paid for it is refunded.`;
  const token = await mintConfirm(
    { actor: actorKey(actor), shopId: actor.shopId, action: "cancel", args: { appointmentId: a.id }, stateKey: fingerprint({ ...a, status: String(a.status) }), summary },
    now,
  );
  return reply(summary, [], { confirm: { token, summary } });
}

async function apptMenu(actor: BarberActor, ctx: Ctx, id: string, now: Date): Promise<BarberReply> {
  const a = await changeable(actor, id, now);
  if (!a) return reply("That appointment can't be changed from here any more.", []);
  return reply(`${apptLabel(a, ctx)} - ${a.service?.name ?? "appointment"}${a.staff?.name ? ` with ${a.staff.name}` : ""}.`, [
    { label: "Move it", pick: pick(actor, "move_day", { id: a.id }) },
    { label: "Cancel it", pick: pick(actor, "cancel", { id: a.id }) },
  ]);
}

// ── one turn ──────────────────────────────────────────────────────────────

export type BarberNav = "menu" | "today" | "tomorrow" | "book" | "move" | "cancel";

export async function runBarberTurn(
  actor: BarberActor,
  input: { text?: string; pick?: string; nav?: BarberNav },
  now = new Date(),
): Promise<BarberReply> {
  const ctx = await loadCtx(actor, now);

  if (input.nav) {
    switch (input.nav) {
      case "menu":
        return reply("What would you like to do?", menu(actor));
      case "today":
        return showDay(actor, ctx, ctx.today, now);
      case "tomorrow":
        return showDay(actor, ctx, addDays(ctx.today, 1), now);
      case "book":
        return reply("Who is the booking for? Type their name.", []);
      case "move":
      case "cancel":
        return pickAppointment(actor, ctx, input.nav, now);
    }
  }

  if (input.pick) {
    const p = readPick(input.pick, { actor: actorKey(actor), shopId: actor.shopId }, now.getTime());
    if (!p) return reply("That button has expired. Here's the menu again.", menu(actor));
    return runPick(actor, ctx, p.name, p.args, now);
  }

  const text = (input.text ?? "").trim();
  if (!text) return NOT_HANDLED;
  const intent = barberIntent(text, { today: ctx.today, services: ctx.services.map((s) => s.name) });
  if (!intent) return NOT_HANDLED;
  switch (intent.kind) {
    case "day":
      return showDay(actor, ctx, intent.date ?? ctx.today, now);
    case "book": {
      const service = intent.service ? servicesFor(actor, ctx).find((s) => s.name === intent.service) : undefined;
      const carry = { ...(service ? { serviceId: service.id } : {}), ...(intent.date ? { date: intent.date } : {}) };
      if (!intent.name) return reply("Who is the booking for? Type their name.", []);
      return bookChooseClient(actor, intent.name, carry);
    }
    case "move":
    case "cancel":
      return pickAppointment(actor, ctx, intent.kind, now, { name: intent.name, date: intent.date, minutes: intent.minutes });
  }
}

async function runPick(actor: BarberActor, ctx: Ctx, name: string, args: Record<string, string>, now: Date): Promise<BarberReply> {
  switch (name) {
    case "day": {
      const date = args.date === "today" ? ctx.today : args.date === "tomorrow" ? addDays(ctx.today, 1) : String(args.date);
      return showDay(actor, ctx, date, now);
    }
    case "book_start":
      return reply("Who is the booking for? Type their name.", []);
    case "book_service":
      return bookChooseService(actor, ctx, args, now);
    case "book_barber":
      return bookChooseBarber(actor, ctx, args, now);
    case "book_day":
      return bookChooseDay(actor, ctx, args, now);
    case "book_time":
      return bookChooseTime(actor, ctx, args, now);
    case "book_go":
      return bookPreview(actor, ctx, args, now);
    case "upcoming":
      return pickAppointment(actor, ctx, args.op === "cancel" ? "cancel" : "move", now);
    case "appt":
      return apptMenu(actor, ctx, String(args.id), now);
    case "move_day":
      return moveChooseDay(actor, ctx, args, now);
    case "move_time":
      return moveChooseTime(actor, ctx, args, now);
    case "move_go":
      return movePreview(actor, ctx, args, now);
    case "cancel":
      return cancelPreview(actor, ctx, String(args.id), now);
    default:
      return reply("What would you like to do?", menu(actor));
  }
}

// ── confirm: the dashboard's own handlers ─────────────────────────────────

/** Run one of the dashboard's write handlers in-process and keep its answer. */
async function runCore(
  core: (req: DashboardWriteReq, res: DashboardWriteRes) => Promise<void>,
  actor: BarberActor,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const res: DashboardWriteRes = {
    status(code: number) {
      out.status = code;
      return {
        json(b: unknown) {
          out.body = (b ?? {}) as Record<string, unknown>;
          return undefined;
        },
      };
    },
    json(b: unknown) {
      out.body = (b ?? {}) as Record<string, unknown>;
      return undefined;
    },
  };
  const req: DashboardWriteReq = { shop: actor.write.shop, userId: actor.write.userId, shopStaffId: actor.write.shopStaffId, body, params };
  await core(req, res);
  return out;
}

/** What a refusal from the dashboard's handler means, in words. */
function refusal(r: { status: number; body: Record<string, unknown> }): string {
  const e = String(r.body.error ?? "");
  if (e === "slot_taken" || e === "same_start") return "That time was just taken, so nothing changed. Pick another time.";
  if (e === "external_block" || e === "slot_unavailable_external") {
    return "That time is blocked on your other calendar, so nothing changed. Book over it from your calendar if you meant to.";
  }
  if (e === "not_reschedulable") return "That appointment can't be moved any more, so nothing changed.";
  if (e === "price_changed" || e === "offer_refused") return `${String(r.body.message ?? "That move changes what was paid.")} Nothing changed.`;
  if (e === "tip_paid" || e === "tip_in_progress") return "This visit has a tip on it, so cancel it from your calendar.";
  if (e === "not_native") return "Booking from chat needs ChairBack booking switched on for this shop.";
  if (r.status === 404) return "That appointment isn't there any more, so nothing changed.";
  return "That didn't go through, so nothing changed. Try it from your calendar.";
}

export async function runBarberConfirm(actor: BarberActor, token: string, now = new Date()): Promise<BarberConfirmReply> {
  const loaded = await loadConfirm(token, { actor: actorKey(actor), shopId: actor.shopId }, now);
  if (!loaded.ok) {
    return loaded.reason === "expired"
      ? { ok: false, text: "That confirmation timed out. Start again and I'll check the time is still free." }
      : { ok: false, text: "That confirmation isn't valid any more." };
  }
  const claim = await claimConfirm(loaded.row.id, now);
  if (claim.kind === "settled") return { ...((claim.row.result as BarberConfirmReply | null) ?? { ok: false, text: "" }), replay: true };
  if (claim.kind === "busy") return { ok: false, pending: true, text: "Still working on that one - check again in a moment." };
  if (claim.kind === "expired") return { ok: false, text: "That confirmation timed out. Start again and I'll check the time is still free." };

  try {
    const ctx = await loadCtx(actor, now);
    const { status, reply: answer } = await redeem(actor, ctx, loaded.row, now);
    await settleConfirm(loaded.row.id, status, answer, now);
    return answer;
  } catch (err) {
    logger.error({ err, shopId: actor.shopId }, "barber chat confirm failed");
    await releaseConfirm(loaded.row.id);
    return { ok: false, text: "That didn't go through, so nothing changed. Try again." };
  }
}

async function redeem(
  actor: BarberActor,
  ctx: Ctx,
  row: ConfirmRow,
  now: Date,
): Promise<{ status: "done" | "failed" | "superseded"; reply: BarberConfirmReply }> {
  const a = row.args;
  const tz = ctx.shop.timezone;
  const failed = (text: string) => ({ status: "failed" as const, reply: { ok: false, text } });
  const done = (text: string) => ({ status: "done" as const, reply: { ok: true, text } });

  if (row.action === "book") {
    if (chairOnly(actor) && a.staffId !== actor.chairId) return failed("You can only book on your own calendar.");
    const r = await runCore(createAppointmentCore, actor, {
      staffId: a.staffId,
      serviceId: a.serviceId,
      startsAt: a.startsAt,
      ...(a.clientId ? { clientId: a.clientId } : { firstName: a.first, lastName: a.last }),
      // The confirmation IS the operation: a retried or recovered confirm is
      // answered by the handler's own replay, never booked twice.
      operationId: `barber-chat:${row.id.slice(0, 40)}`,
    });
    if (r.status !== 201 && r.status !== 200) return failed(refusal(r));
    void noteAvailabilityChanged(actor.shopId);
    return done(`Booked: ${String(a.who)}, ${when(new Date(String(a.startsAt)), tz)}. They'll get the usual confirmation.`);
  }

  const appt = await runWithShop(actor.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: String(a.appointmentId), shopId: actor.shopId },
      select: { id: true, startsAt: true, status: true, staffId: true, firstName: true, lastName: true },
    }),
  );
  if (!appt || (chairOnly(actor) && appt.staffId !== actor.chairId)) return failed("That appointment isn't there any more, so nothing changed.");
  const who = fullName(appt.firstName, appt.lastName);

  if (row.action === "move") {
    const to = new Date(String(a.startsAt));
    // Already there (a retry after it went through): say so, change nothing.
    if (appt.status === "BOOKED" && appt.startsAt.getTime() === to.getTime()) return done(`Moved: ${who}, now ${when(to, tz)}.`);
    if (fingerprint({ ...appt, status: String(appt.status) }) !== row.stateKey) {
      return failed("That appointment changed since you looked, so nothing was moved. Start again to see it as it is now.");
    }
    const r = await runCore(
      rescheduleAppointmentCore,
      actor,
      { startsAt: to.toISOString(), ...(a.acceptPriceCents !== undefined ? { acceptPriceCents: Number(a.acceptPriceCents) } : {}) },
      { id: appt.id },
    );
    if (r.status === 409 && r.body.error === "price_changes") {
      // The new day is priced differently: ask again with the real numbers.
      const toCents = Number(r.body.toCents);
      const fresh = await movePreview(actor, ctx, { id: appt.id, startsAt: to.toISOString() }, now, toCents);
      const summary = `That day is priced at $${(toCents / 100).toFixed(2)} (it was $${(Number(r.body.fromCents) / 100).toFixed(2)}). ${fresh.confirm?.summary ?? ""}`;
      return { status: "superseded", reply: { ok: false, text: summary, ...(fresh.confirm ? { confirm: { token: fresh.confirm.token, summary } } : {}) } };
    }
    if (r.status !== 200) return failed(refusal(r));
    void noteAvailabilityChanged(actor.shopId);
    return done(`Moved: ${who}, now ${when(to, tz)}. They'll get an email with the new time.`);
  }

  // cancel
  if (appt.status === "CANCELED") return done(`Cancelled: ${who}, ${when(appt.startsAt, tz)}.`);
  if (fingerprint({ ...appt, status: String(appt.status) }) !== row.stateKey) {
    return failed("That appointment changed since you looked, so nothing was cancelled. Start again to see it as it is now.");
  }
  const r = await runCore(cancelAppointmentCore, actor, {}, { id: appt.id });
  if (r.status !== 200 || r.body.ok !== true) return failed(refusal(r));
  void noteAvailabilityChanged(actor.shopId);
  return done(`Cancelled: ${who}, ${when(appt.startsAt, tz)}. They'll get the usual cancellation email.`);
}

/** For the route: a staff barber's whole scope is their chair. Exported for tests. */
export function staffNeedsChair(role: BarberRole, chairId: string | null): boolean {
  return role === "BARBER" && !chairId;
}

/** Wall-clock helper the route uses to keep "today" in the shop's zone. Exported for tests. */
export const __forTests = { dayKey, timeOfDay };
