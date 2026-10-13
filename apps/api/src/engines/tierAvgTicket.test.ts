import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken, type TierRules } from "@chairback/config";
import { readChairEvents } from "./insightsWindow.js";
import { loadClientTierStats, loadTierStats } from "./tierStats.js";

/**
 * AVERAGE TICKET, AS A TIER COUNTS IT.
 *
 * average = the client's qualifying spend / their qualifying visits, over the
 * window - and the two halves are the SAME visits:
 *
 *   - COMPLETED only (a no-show, a cancellation and a booking whose time
 *     passed without being completed are in neither half);
 *   - each visit's amount is readChairEvents' per-row figure: a refund
 *     lowers it, a tip never raises it, a checkout figure wins;
 *   - an imported visit with no price is UNKNOWN - out of both halves, never
 *     averaged in as $0;
 *   - a native booking and the Visit promoted from it are one visit;
 *   - no qualifying visit = null, never 0.
 */

const DAY = 86_400_000;
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const userIds: string[] = [];
let shopId = "";
let staffId = "";
let serviceId = "";

const RULES_90: TierRules = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: null, spend: null, avgTicket: { minCents: 4_000, windowDays: 90 }, match: "all" },
  GOLD: { visits: null, spend: null, avgTicket: { minCents: 6_000, windowDays: 90 }, match: "all" },
};
/** Spend all time AND average all time - to read both off one load. */
const RULES_ALL_TIME: TierRules = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: null, spend: { minCents: 100, windowDays: 0 }, match: "all" },
  GOLD: { visits: null, spend: null, avgTicket: { minCents: 6_000, windowDays: 0 }, match: "all" },
};

async function newClient(name: string): Promise<string> {
  const c = await prisma.client.create({
    data: { shopId, acuityClientKey: `k-${randomToken(8)}`, magicToken: randomToken(), firstName: name, source: "manual" },
    select: { id: true },
  });
  return c.id;
}

async function native(
  clientId: string,
  o: {
    daysAgo: number;
    status: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED";
    price: number | null;
    paid?: number;
    payments?: { purpose: string; status: string; amount: number; refundedAmount?: number }[];
  },
): Promise<string> {
  const startsAt = ago(o.daysAgo);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Pat",
      status: o.status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: o.price,
      ...(o.paid === undefined ? {} : { paidAmount: o.paid, paidMethod: "cash", paidAt: startsAt }),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  for (const p of o.payments ?? []) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: appt.id,
        purpose: p.purpose,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: p.amount,
        refundedAmount: p.refundedAmount ?? 0,
        status: p.status,
      },
    });
  }
  return appt.id;
}

async function imported(
  clientId: string,
  o: { daysAgo: number; price: number | null; status?: "COMPLETED" | "NO_SHOW" | "CANCELED" | "SCHEDULED" },
): Promise<string> {
  const v = await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `a-${randomToken(8)}`,
      scheduledAt: ago(o.daysAgo),
      status: o.status ?? "COMPLETED",
      price: o.price,
    },
    select: { id: true },
  });
  return v.id;
}

let nativeClient = "";
let importedClient = "";
let promotedClient = "";
let refundedClient = "";
let noDataClient = "";
let boundaryClient = "";

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `avg-${randomToken(6)}@test.chairback`.toLowerCase(), name: "A" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Average Cuts",
      slug: `avg-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;

  // Native: $40 ticket; $60 paid through ChairBack less a $20 refund; a $50
  // checkout with an $8 tip; and three rows that are NOT tickets.
  nativeClient = await newClient("Native");
  await native(nativeClient, { daysAgo: 10, status: "COMPLETED", price: 40 });
  await native(nativeClient, {
    daysAgo: 11,
    status: "COMPLETED",
    price: 60,
    payments: [{ purpose: "booking", status: "partially_refunded", amount: 6_000, refundedAmount: 2_000 }],
  });
  await native(nativeClient, {
    daysAgo: 12,
    status: "COMPLETED",
    price: 50,
    paid: 50,
    payments: [{ purpose: "tip", status: "succeeded", amount: 800 }],
  });
  await native(nativeClient, { daysAgo: 13, status: "NO_SHOW", price: 500 });
  await native(nativeClient, { daysAgo: 14, status: "CANCELED", price: 500 });
  // Its time has passed but nobody completed it.
  await native(nativeClient, { daysAgo: 15, status: "BOOKED", price: 500 });

  // Imported: $30, $90, and one with no price at all.
  importedClient = await newClient("Imported");
  await imported(importedClient, { daysAgo: 20, price: 30 });
  await imported(importedClient, { daysAgo: 21, price: 90 });
  await imported(importedClient, { daysAgo: 22, price: null });
  await imported(importedClient, { daysAgo: 23, price: 400, status: "NO_SHOW" });

  // A native $80 booking promoted into a Visit (same $80), plus a $20 import.
  // Counted once: (80 + 20) / 2 = $50. Counted twice it would read $60.
  promotedClient = await newClient("Promoted");
  const apptId = await native(promotedClient, { daysAgo: 5, status: "COMPLETED", price: 80 });
  const promoted = await prisma.visit.create({
    data: {
      shopId,
      clientId: promotedClient,
      acuityAppointmentId: `booking:${apptId}`,
      scheduledAt: ago(5),
      status: "COMPLETED",
      price: 80,
    },
    select: { id: true },
  });
  await prisma.appointment.update({ where: { id: apptId }, data: { visitId: promoted.id } });
  await imported(promotedClient, { daysAgo: 6, price: 20 });

  // A fully refunded cut is a KNOWN $0 - it stays in, unlike an unknown price.
  refundedClient = await newClient("Refunded");
  await native(refundedClient, {
    daysAgo: 3,
    status: "COMPLETED",
    price: 40,
    payments: [{ purpose: "booking", status: "refunded", amount: 4_000, refundedAmount: 4_000 }],
  });
  await native(refundedClient, { daysAgo: 4, status: "COMPLETED", price: 60 });

  // Only rows that are not tickets: no average.
  noDataClient = await newClient("NoData");
  await imported(noDataClient, { daysAgo: 2, price: null });
  await native(noDataClient, { daysAgo: 2, status: "NO_SHOW", price: 100 });
  await native(noDataClient, { daysAgo: 3, status: "COMPLETED", price: null });

  // Window edges: exactly 90 days back is IN, a minute older is OUT.
  boundaryClient = await newClient("Boundary");
  await imported(boundaryClient, { daysAgo: 90, price: 100 });
  await imported(boundaryClient, { daysAgo: 90 + 1 / 1440, price: 20 });
  await imported(boundaryClient, { daysAgo: 200, price: 20 });
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
});

const statsFor = (clientId: string, rules: TierRules) =>
  runWithShop(shopId, (tx) => loadClientTierStats(tx, shopId, clientId, rules, NOW));

describe("loadTierStats - avgTicketCents", () => {
  it("🔴 completed visits only; a refund lowers it; a tip never raises it", async () => {
    const s = await statsFor(nativeClient, RULES_90);
    // (40 + (60 - 20) + 50) / 3 = 43.33 - the no-show, the cancellation and
    // the never-completed $500 booking are in NEITHER half.
    expect(s.avgTicketCents).toEqual({ 90: 4_333 });
  });

  it("🔴 an imported visit with no price is out of BOTH halves, not a $0 ticket", async () => {
    const s = await statsFor(importedClient, RULES_90);
    // (30 + 90) / 2 = $60. Averaged in as $0 it would read $40.
    expect(s.avgTicketCents).toEqual({ 90: 6_000 });
  });

  it("🔴 a booking and the Visit promoted from it count once", async () => {
    const s = await statsFor(promotedClient, RULES_90);
    expect(s.avgTicketCents).toEqual({ 90: 5_000 });
  });

  it("a fully refunded cut is a known $0 and stays in", async () => {
    const s = await statsFor(refundedClient, RULES_90);
    expect(s.avgTicketCents).toEqual({ 90: 3_000 });
  });

  it("🔴 no qualifying visit is null, never 0", async () => {
    expect((await statsFor(noDataClient, RULES_90)).avgTicketCents).toEqual({ 90: null });
    // A client with no rows at all, read alone and in the shop-wide load.
    const nobody = await newClient("Nobody");
    expect((await statsFor(nobody, RULES_90)).avgTicketCents).toEqual({ 90: null });
    const all = await runWithShop(shopId, (tx) => loadTierStats(tx, shopId, RULES_90, NOW));
    expect(all.get(noDataClient)?.avgTicketCents).toEqual({ 90: null });
  });

  it("window boundary: exactly 90 days back is in, older is out; all time takes everything", async () => {
    expect((await statsFor(boundaryClient, RULES_90)).avgTicketCents).toEqual({ 90: 10_000 });
    const all = await statsFor(boundaryClient, RULES_ALL_TIME);
    expect(all.avgTicketCents).toEqual({ 0: Math.round((10_000 + 2_000 + 2_000) / 3) });
  });

  it("the shop-wide load agrees with the one-client load for every client", async () => {
    const all = await runWithShop(shopId, (tx) => loadTierStats(tx, shopId, RULES_90, NOW));
    for (const id of [nativeClient, importedClient, promotedClient, refundedClient, noDataClient, boundaryClient]) {
      expect(all.get(id)?.avgTicketCents, id).toEqual((await statsFor(id, RULES_90)).avgTicketCents);
    }
  });

  it("money spent is counted exactly as before, beside the average", async () => {
    const s = await statsFor(nativeClient, RULES_ALL_TIME);
    // Spend keeps its own long-standing rule, past-but-never-completed $500
    // included (a known mismatch with visits, unchanged here).
    expect(s.spendCents).toEqual({ 0: 4_000 + 4_000 + 5_000 + 50_000 });
    expect(s.avgTicketCents).toEqual({ 0: 4_333 });
  });

  it("a shop whose rules never ask carries no average at all", async () => {
    const plain: TierRules = {
      BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
      SILVER: { visits: { min: 2, windowDays: 0 }, spend: null, match: "all" },
      GOLD: { visits: { min: 3, windowDays: 0 }, spend: null, match: "all" },
    };
    const s = await statsFor(nativeClient, plain);
    expect("avgTicketCents" in s).toBe(false);
  });
});

describe("readChairEvents - completedTickets", () => {
  it("names the completed, known-amount rows, each with its own earnedCents", async () => {
    const { events, completedTickets } = await readChairEvents(shopId, ago(30), NOW, { clientId: nativeClient });
    expect(completedTickets.map((t) => t.cents).sort()).toEqual([4_000, 4_000, 5_000]);
    // Every ticket IS one of the events, with the same money - not a second
    // revenue rule.
    for (const t of completedTickets) {
      expect(events.some((e) => e.start.getTime() === t.start.getTime() && e.earnedCents === t.cents)).toBe(true);
    }
  });
});
