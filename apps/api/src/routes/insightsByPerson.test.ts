import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The per-person report: the Insights totals, split by who took the
 * appointment (GET /api/insights `byPerson`), and one team member's own row
 * (GET /api/barber/report).
 *
 * What is load-bearing:
 *   - 🔴 THE ROWS ADD UP. Everyone's row plus "not assigned" (synced bookings,
 *     which record nobody) equals the total the owner already reads on the
 *     same page, for the same window. A split that does not sum reads as money
 *     gone missing.
 *   - 🔴 A TEAM MEMBER GETS THEIR OWN ROW AND NOTHING ELSE: no colleague, no
 *     shop total, and no way to ask for someone else's by passing an id.
 *   - A one-person shop is sent no split at all: its page is what it was.
 *
 * 🔴 TIME IS FROZEN at a fixed PAST instant, Wednesday 2026-06-17 noon in New
 * York. Every fixture is an absolute instant around it.
 */
const FROZEN_NOW = new Date("2026-06-17T16:00:00.000Z"); // Wed 12:00 EDT
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie: string;
let soloCookie: string;
let deeCookie: string; // a team member, linked to Dee
let goneCookie: string; // linked to someone taken off the booking page
let unlinkedCookie: string; // a team member with nobody linked
let shopId: string;
let soloShopId: string;
let sam: string;
let dee: string;
let gone: string;
let serviceId: string;

interface Row {
  staffId: string;
  name: string;
  active: boolean;
  visits: number;
  noShows: number;
  revenueCents: number;
  tipsCents: number;
}
interface ByPerson {
  rows: Row[];
  notAssigned: { visits: number; noShows: number; revenueCents: number } | null;
  total: { visits: number; noShows: number; revenueCents: number; tipsCents: number };
  tips: boolean;
}
interface Insights {
  scope: string;
  byPerson: ByPerson | null;
  totals: { visits: number; revenue: number; noShows: number };
}

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

async function openShop(cookie: string, name: string): Promise<string> {
  const made = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "America/New_York" });
  return made.body.id as string;
}

async function appointment(
  shop: string,
  staffId: string,
  service: string,
  startsAt: string,
  price: number,
  status: "BOOKED" | "COMPLETED" | "NO_SHOW" = "COMPLETED",
  cashTipCents?: number,
) {
  const start = new Date(startsAt);
  return prisma.appointment.create({
    data: {
      shopId: shop,
      staffId,
      serviceId: service,
      firstName: "Reg",
      status,
      startsAt: start,
      endsAt: new Date(start.getTime() + 45 * 60_000),
      priceAtBooking: price,
      manageToken: randomToken(),
      ...(cashTipCents === undefined
        ? {}
        : { recordedTipCents: cashTipCents, recordedTipMethod: "cash", recordedTipAt: start }),
    },
    select: { id: true },
  });
}

/** An Acuity-style synced visit: no native appointment, and nobody against it. */
async function syncedVisit(shop: string, scheduledAt: string, price: number) {
  const at = new Date(scheduledAt);
  const client = await prisma.client.create({
    data: {
      shopId: shop,
      acuityClientKey: `byperson-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Synced",
    },
    select: { id: true },
  });
  await prisma.visit.create({
    data: {
      shopId: shop,
      clientId: client.id,
      acuityAppointmentId: `byperson-${randomToken(8)}`,
      status: "COMPLETED",
      scheduledAt: at,
      endAt: new Date(at.getTime() + 30 * 60_000),
      completedAt: at,
      serviceName: "Haircut",
      price,
    },
  });
}

async function insights(cookie: string, query = "?period=30d"): Promise<Insights> {
  const res = await request(app).get(`/api/insights${query}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as Insights;
}

const service = async (shop: string) =>
  (
    await prisma.service.create({
      data: { shopId: shop, name: "Fade", durationMin: 45, price: 40 },
      select: { id: true },
    })
  ).id;

const person = async (shop: string, name: string, sortOrder: number, active = true) =>
  (await prisma.staff.create({ data: { shopId: shop, name, sortOrder, active }, select: { id: true } })).id;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });

  const owner = await signup("byperson-owner");
  ownerCookie = owner.cookie;
  shopId = await openShop(ownerCookie, "Split Cuts");
  serviceId = await service(shopId);
  sam = await person(shopId, "Sam", 1);
  dee = await person(shopId, "Dee", 2);
  gone = await person(shopId, "Gone Gary", 3, false);
  // Taken off the booking page AND idle in every window: never a row.
  await person(shopId, "Idle Ida", 4, false);

  // ── Sam: two visits and a no-show, with an online tip on one ──────────────
  await appointment(shopId, sam, serviceId, "2026-06-15T15:00:00.000Z", 40);
  // Monday 11:30pm in New York is Tuesday 03:30 UTC: still inside the window.
  const late = await appointment(shopId, sam, serviceId, "2026-06-16T03:30:00.000Z", 40);
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId: late.id,
      purpose: "tip",
      stripePaymentIntentId: `pi_byperson_${randomToken(10)}`,
      stripeConnectAccountId: "acct_byperson_test",
      mode: "ahead",
      amount: 800,
      status: "succeeded",
    },
  });
  await appointment(shopId, sam, serviceId, "2026-06-12T15:00:00.000Z", 40, "NO_SHOW");

  // ── Dee: one visit with a cash tip; one still AHEAD; one before the 30 days ─
  await appointment(shopId, dee, serviceId, "2026-06-16T15:00:00.000Z", 55, "COMPLETED", 500);
  const ahead = await appointment(shopId, dee, serviceId, "2026-06-18T15:00:00.000Z", 70, "BOOKED");
  // A tip paid when booking tomorrow: real money, but for a visit that has not
  // happened. It is filed under that visit, so it is not in today's numbers.
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId: ahead.id,
      purpose: "tip",
      stripePaymentIntentId: `pi_byperson_${randomToken(10)}`,
      stripeConnectAccountId: "acct_byperson_test",
      mode: "ahead",
      amount: 600,
      status: "succeeded",
    },
  });
  await appointment(shopId, dee, serviceId, "2026-04-01T15:00:00.000Z", 100, "COMPLETED", 900);

  // ── Someone since taken off the booking page, who worked in the window ────
  await appointment(shopId, gone, serviceId, "2026-06-10T15:00:00.000Z", 30);

  // ── A synced booking: nobody recorded against it ─────────────────────────
  await syncedVisit(shopId, "2026-06-11T15:00:00.000Z", 25);

  // ── Team members ─────────────────────────────────────────────────────────
  const seat = async (label: string, staffId: string | null) => {
    const who = await signup(label);
    await prisma.shopMember.create({ data: { shopId, userId: who.userId, role: "BARBER", staffId } });
    return who.cookie;
  };
  deeCookie = await seat("byperson-dee", dee);
  goneCookie = await seat("byperson-gone", gone);
  unlinkedCookie = await seat("byperson-nolink", null);

  // ── A one-person shop, with synced work beside its own ───────────────────
  const solo = await signup("byperson-solo");
  soloCookie = solo.cookie;
  soloShopId = await openShop(soloCookie, "Solo Cuts");
  const soloService = await service(soloShopId);
  const me = await person(soloShopId, "Just Me", 1);
  await appointment(soloShopId, me, soloService, "2026-06-15T15:00:00.000Z", 40);
  await syncedVisit(soloShopId, "2026-06-11T15:00:00.000Z", 25);
});

afterAll(async () => {
  vi.useRealTimers();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const row = (b: ByPerson, staffId: string) => b.rows.find((r) => r.staffId === staffId)!;

describe("Insights, split by person", () => {
  it("🔴 the rows plus 'not assigned' are exactly the totals on the same page", async () => {
    const body = await insights(ownerCookie);
    const by = body.byPerson!;
    expect(by).not.toBeNull();

    const visits = by.rows.reduce((n, r) => n + r.visits, 0) + (by.notAssigned?.visits ?? 0);
    const noShows = by.rows.reduce((n, r) => n + r.noShows, 0) + (by.notAssigned?.noShows ?? 0);
    const cents = by.rows.reduce((n, r) => n + r.revenueCents, 0) + (by.notAssigned?.revenueCents ?? 0);
    expect(visits).toBe(body.totals.visits);
    expect(noShows).toBe(body.totals.noShows);
    expect(Math.round(cents / 100)).toBe(body.totals.revenue);
    expect(by.total).toMatchObject({ visits, noShows, revenueCents: cents });
    expect(by.total.tipsCents).toBe(by.rows.reduce((n, r) => n + r.tipsCents, 0));
    // And the totals themselves are the fixture's, so a split that summed to
    // an empty page could not pass.
    expect(body.totals).toMatchObject({ visits: 6, revenue: 190, noShows: 1 });
  });

  it("each person's own figures: a no-show counts as a visit that earned nothing, tips sit apart", async () => {
    const by = (await insights(ownerCookie)).byPerson!;
    expect(row(by, sam)).toEqual({
      staffId: sam,
      name: "Sam",
      active: true,
      visits: 3,
      noShows: 1,
      revenueCents: 8000,
      tipsCents: 800,
    });
    // The booking still ahead and the one before the window are not in here.
    expect(row(by, dee)).toMatchObject({ visits: 1, noShows: 0, revenueCents: 5500, tipsCents: 500 });
    expect(by.notAssigned).toEqual({ visits: 1, noShows: 0, revenueCents: 2500 });
    expect(by.tips).toBe(true);
  });

  it("someone taken off the booking page stays while they have work in the window, and goes when they don't", async () => {
    const by = (await insights(ownerCookie)).byPerson!;
    expect(by.rows.map((r) => r.name)).toEqual(["Sam", "Dee", "Gone Gary"]);
    expect(row(by, gone)).toMatchObject({ active: false, visits: 1, revenueCents: 3000, tipsCents: 0 });
    // The last 7 days start on Jun 11: their Jun 10 visit is outside it.
    const week = (await insights(ownerCookie, "?period=7d")).byPerson!;
    expect(week.rows.map((r) => r.name)).toEqual(["Sam", "Dee"]);
  });

  it("a wider window moves the rows and the totals together", async () => {
    const body = await insights(ownerCookie, "?period=90d");
    const by = body.byPerson!;
    expect(row(by, dee)).toMatchObject({ visits: 2, revenueCents: 15500, tipsCents: 1400 });
    const cents = by.rows.reduce((n, r) => n + r.revenueCents, 0) + (by.notAssigned?.revenueCents ?? 0);
    expect(Math.round(cents / 100)).toBe(body.totals.revenue);
    expect(by.rows.reduce((n, r) => n + r.visits, 0) + (by.notAssigned?.visits ?? 0)).toBe(body.totals.visits);
  });

  it("🔴 a one-person shop is sent no split, synced work or not", async () => {
    const body = await insights(soloCookie);
    expect(body.totals).toMatchObject({ visits: 2, revenue: 65 });
    expect(body.byPerson).toBeNull();
  });

  describe("on the Starter peek", () => {
    // Plans only bite where billing is switched on, which it is not in this
    // suite's environment. On for this block alone, and put back after: the
    // worker process outlives the file.
    const STRIPE = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"] as const;
    const before: Record<string, string | undefined> = {};
    let was: { plan: string; subscriptionStatus: string; trialEndsAt: Date | null };
    beforeAll(async () => {
      for (const k of STRIPE) {
        before[k] = process.env[k];
        process.env[k] = "byperson_test_dummy";
      }
      __resetEnvCacheForTests();
      was = await prisma.shop.findUniqueOrThrow({
        where: { id: shopId },
        select: { plan: true, subscriptionStatus: true, trialEndsAt: true },
      });
      await prisma.shop.update({
        where: { id: shopId },
        data: { plan: "starter", subscriptionStatus: "active", trialEndsAt: new Date("2026-06-01T00:00:00.000Z") },
      });
    });
    afterAll(async () => {
      await prisma.shop.update({ where: { id: shopId }, data: was });
      for (const k of STRIPE) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
      __resetEnvCacheForTests();
    });

    it("the headline numbers are split too, and tips (not a headline number) are not sent", async () => {
      const body = await insights(ownerCookie);
      expect(body.scope).toBe("peek");
      const by = body.byPerson!;
      expect(row(by, sam)).toMatchObject({ visits: 3, revenueCents: 8000, tipsCents: 0 });
      expect(by.tips).toBe(false);
      expect(by.total.tipsCents).toBe(0);
    });
  });
});

describe("a team member's own numbers", () => {
  const report = (cookie: string, query = "") =>
    request(app).get(`/api/barber/report${query}`).set("Cookie", cookie);

  it("🔴 is the same row the owner sees beside their name", async () => {
    const owners = row((await insights(ownerCookie)).byPerson!, dee);
    const res = await report(deeCookie, "?period=30d");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chair: { id: dee, name: "Dee" },
      reason: null,
      period: "30d",
      periodLabel: "Last 30 days",
      visits: owners.visits,
      noShows: owners.noShows,
      revenueCents: owners.revenueCents,
      tipsCents: owners.tipsCents,
    });
    expect(res.body.visits).toBe(1);
    expect(res.body.revenueCents).toBe(5500);
  });

  it("🔴 holds nobody else's row and no shop total", async () => {
    const res = await report(deeCookie, "?period=90d");
    expect(Object.keys(res.body).sort()).toEqual(
      [
        "chair",
        "noShows",
        "period",
        "periodLabel",
        "periods",
        "reason",
        "revenueCents",
        "tipsCents",
        "visits",
        "windowEnd",
        "windowStart",
      ].sort(),
    );
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(sam);
    expect(wire).not.toContain("Sam");
    expect(wire).not.toContain(gone);
    // Dee's own 90 days: the April visit is back in.
    expect(res.body).toMatchObject({ visits: 2, revenueCents: 15500, tipsCents: 1400 });
  });

  it("🔴 an id in the request is not read: asking for a colleague returns your own", async () => {
    const mine = await report(deeCookie, "?period=30d");
    for (const query of [`?period=30d&staffId=${sam}`, `?period=30d&staff=${sam}&chair=${sam}`]) {
      const res = await report(deeCookie, query);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mine.body);
    }
    // Sam's 30 days hold three visits; none of that reached Dee.
    expect(mine.body.visits).toBe(1);
  });

  it("tips are left out, not shown as zero, where there have been none", async () => {
    const res = await report(goneCookie, "?period=30d");
    expect(res.body).toMatchObject({ visits: 1, revenueCents: 3000, tipsCents: null });
  });

  it("a login with nobody linked gets no numbers, and a reason", async () => {
    for (const cookie of [unlinkedCookie, ownerCookie]) {
      const res = await report(cookie);
      expect(res.status).toBe(200);
      expect(res.body.chair).toBeNull();
      expect(res.body.reason).toBe("no_chair_linked");
      expect(res.body).not.toHaveProperty("revenueCents");
      expect(res.body).not.toHaveProperty("visits");
    }
  });

  it("the shop's Insights stay closed to a team member", async () => {
    const res = await request(app).get("/api/insights?period=30d").set("Cookie", deeCookie);
    expect(res.status).toBe(403);
  });
});
