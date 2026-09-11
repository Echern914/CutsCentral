import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, apiEnv, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { mintSessionToken } from "../auth/session.js";
import { __setExpoSenderForTests, sendPushToClient } from "../messaging/push.js";

/**
 * /api/me - My ChairBack from the outside.
 *
 * The contract, in the order a reviewer should check it:
 *   1. A customer sees their OWN records at every shop that has them - and
 *      nothing else: not another customer's, not a record they disowned, not
 *      a record that stopped matching their proof.
 *   2. Native and synced history is one list with the canonical statuses; a
 *      completed native booking is not doubled; a pending request is
 *      "Requested", never "Booked".
 *   3. Rewards appear only where the shop offers them, per shop, never summed.
 *   4. Private barber text never crosses the wire.
 *
 * Accounts are created directly (sign-in has its own suite) and each test
 * builds its own customer with a RANDOM phone, so no row from another suite
 * or an earlier run can ever match - the linking engine searches every shop.
 */

const app = createApp();
const SECRET = "SECRET-PRIVATE-MARKER";

let ownerId: string;
let shopA: string; // "Alpha Cuts" - a barbershop, rewards ON
let shopB: string; // "Bravo Salon" - a salon, rewards OFF
let staffA: string;
let serviceA: string;
let staffB: string;
let serviceB: string;
const accountIds = new Set<string>();
let slot = 0;

const DAY = 24 * 60 * 60 * 1000;
const from = (ms: number) => new Date(Date.now() + ms);

/** A valid, random US mobile - never one another suite uses. */
function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1628${exch}${line}`;
}

async function account(opts: { phone?: string; email?: string; firstName?: string; isDemo?: boolean }) {
  const now = new Date();
  const acct = await prisma.customerAccount.create({
    data: {
      firstName: opts.firstName ?? null,
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? now : null,
      emailNormalized: opts.email ?? null,
      emailVerifiedAt: opts.email ? now : null,
      isDemo: opts.isDemo ?? false,
    },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0, { demo: opts.isDemo }) };
}

async function client(shopId: string, over: { phone?: string | null; email?: string | null; firstName?: string } = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `test:${randomToken(8)}`,
      firstName: over.firstName ?? "Jordan",
      phone: over.phone ?? null,
      email: over.email ?? null,
      magicToken: randomToken(),
      notes: `${SECRET} client note`,
    },
    select: { id: true, magicToken: true },
  });
}

async function appointment(
  shopId: string,
  clientId: string,
  over: {
    status: "PENDING" | "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
    startsAt: Date;
    holdExpiresAt?: Date | null;
    holdReason?: string | null;
  },
) {
  slot += 1;
  // Distinct minutes: the (staffId, startsAt) partial unique covers BOOKED+PENDING.
  const startsAt = new Date(over.startsAt.getTime() + slot * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: shopId === shopA ? staffA : staffB,
      serviceId: shopId === shopA ? serviceA : serviceB,
      clientId,
      firstName: "Jordan",
      status: over.status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      holdExpiresAt: over.holdExpiresAt ?? null,
      holdReason: over.holdReason ?? null,
      manageToken: randomToken(),
      notes: `${SECRET} appointment note`,
      intake: { answer: `${SECRET} intake` },
      priceAtBooking: 45,
    },
    select: { id: true, manageToken: true, startsAt: true },
  });
}

async function visit(
  shopId: string,
  clientId: string,
  over: { id: string; status: "SCHEDULED" | "COMPLETED" | "CANCELED" | "NO_SHOW"; at: Date; serviceName?: string },
) {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: over.id,
      status: over.status,
      scheduledAt: over.at,
      serviceName: over.serviceName ?? null,
    },
    select: { id: true },
  });
}

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const send = (method: "post" | "patch" | "delete", path: string, token: string, body: object = {}) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  __resetEnvCacheForTests();
  const owner = await prisma.user.create({
    data: { email: `me-owner-${randomToken(6)}@test.local`.toLowerCase(), passwordHash: "x", name: "Owner" },
  });
  ownerId = owner.id;
  const mk = (name: string, industry: string, rewardsEnabled: boolean) =>
    prisma.shop.create({
      data: {
        ownerId,
        name,
        slug: `me-${randomToken(6)}`.toLowerCase(),
        bookingMode: "native",
        webhookSecret: randomToken(),
        compAccess: true,
        timezone: "America/New_York",
        industry,
        businessTypeSelectedAt: new Date(),
        rewardsEnabled,
        addressStreet: "12 Main St",
        addressCity: "Brooklyn",
        addressRegion: "NY",
        addressPostal: "11201",
      },
      select: { id: true },
    });
  shopA = (await mk("Alpha Cuts", "barber", true)).id;
  shopB = (await mk("Bravo Salon", "salon", false)).id;
  staffA = (await prisma.staff.create({ data: { shopId: shopA, name: "Drick", imageUrl: "https://img.test/drick.jpg" } })).id;
  serviceA = (await prisma.service.create({ data: { shopId: shopA, name: "Skin fade", durationMin: 30 } })).id;
  staffB = (await prisma.staff.create({ data: { shopId: shopB, name: "Sam" } })).id;
  serviceB = (await prisma.service.create({ data: { shopId: shopB, name: "Silk press", durationMin: 60 } })).id;
  await prisma.reward.create({ data: { shopId: shopA, name: "$10 off", punchCost: 5 } });
  // Rewards OFF at Bravo, but with a menu - proves "off" hides it, not "empty".
  await prisma.reward.create({ data: { shopId: shopB, name: "Free treatment", punchCost: 3 } });
});

afterEach(() => {
  __setExpoSenderForTests(undefined);
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  if (accountIds.size > 0) {
    await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  }
  if (ownerId) {
    const shops = [shopA, shopB].filter(Boolean);
    await prisma.punchLedger.deleteMany({ where: { shopId: { in: shops } } });
    await prisma.shop.deleteMany({ where: { ownerId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

/** One customer, two shops, a full history - built fresh per test that needs it. */
async function regular() {
  const phone = randomPhone();
  const a1 = await client(shopA, { phone, firstName: "Jordan" });
  const b1 = await client(shopB, { phone, firstName: "Jordan" });
  const booked = await appointment(shopA, a1.id, { status: "BOOKED", startsAt: from(1 * DAY) });
  const requested = await appointment(shopA, a1.id, { status: "PENDING", startsAt: from(3 * DAY) });
  const done = await appointment(shopA, a1.id, { status: "COMPLETED", startsAt: from(-14 * DAY) });
  // The promoter's Visit for that completed booking - must NOT show twice.
  const promoted = await visit(shopA, a1.id, { id: `booking:${done.id}`, status: "COMPLETED", at: done.startsAt });
  await prisma.appointment.update({ where: { id: done.id }, data: { visitId: promoted.id } });
  await appointment(shopA, a1.id, { status: "CANCELED", startsAt: from(-20 * DAY) });
  await appointment(shopA, a1.id, { status: "NO_SHOW", startsAt: from(-25 * DAY) });
  const acuityNext = await visit(shopA, a1.id, {
    id: String(Math.floor(Math.random() * 1e9)),
    status: "SCHEDULED",
    at: from(5 * DAY),
    serviceName: "Line up",
  });
  await visit(shopA, a1.id, {
    id: String(Math.floor(Math.random() * 1e9)),
    status: "COMPLETED",
    at: from(-30 * DAY),
    serviceName: "Beard trim",
  });
  await visit(shopB, b1.id, { id: `square:${randomToken(6)}`, status: "COMPLETED", at: from(-10 * DAY), serviceName: null as never });
  // Two punches earned at Alpha, on the completed visit.
  await prisma.punchLedger.create({
    data: { shopId: shopA, clientId: a1.id, visitId: promoted.id, punchesEarned: 2, runningBalance: 2, note: "visit" },
  });
  const me = await account({ phone, firstName: "Jordan" });
  return { phone, a1, b1, booked, requested, done, promoted, acuityNext, me };
}

describe("the doors", () => {
  it("flag off -> /api/me is a plain 404", async () => {
    const me = await account({ phone: randomPhone() });
    process.env.CUSTOMER_ACCOUNTS_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect((await get("/api/me/home", me.token)).status).toBe(404);
    } finally {
      process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });

  it("no token, a garbage token, or a BUSINESS session are all 401", async () => {
    expect((await request(app).get("/api/me/home")).status).toBe(401);
    expect((await get("/api/me/home", "abc.def")).status).toBe(401);
    // A real barber session, signed with the business key, cannot read /api/me.
    expect((await get("/api/me/home", mintSessionToken(ownerId))).status).toBe(401);
  });

  it("🔴 a customer session cannot open a business route", async () => {
    const me = await account({ phone: randomPhone() });
    const res = await request(app).get("/api/shops/me").set("Authorization", `Bearer ${me.token}`);
    expect(res.status).toBe(401);
  });

  it("a revoked session (tokenVersion bumped) is dead", async () => {
    const me = await account({ phone: randomPhone() });
    await prisma.customerAccount.update({ where: { id: me.id }, data: { tokenVersion: 1 } });
    expect((await get("/api/me/home", me.token)).status).toBe(401);
  });
});

describe("a new customer", () => {
  it("with no records anywhere gets a calm, empty home - not an error", async () => {
    const me = await account({ phone: randomPhone() });
    const res = await get("/api/me/home", me.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      next: null,
      upcomingCount: 0,
      shops: [],
      rewards: [],
      recent: [],
      vocabulary: { providerNounPlural: "providers", serviceNoun: "visit" },
    });
  });
});

describe("the home", () => {
  it("leads with the next appointment, and a request is never 'Booked'", async () => {
    const { me, booked, requested } = await regular();
    const res = await get("/api/me/home", me.token);
    expect(res.status).toBe(200);
    const home = res.body;
    expect(home.firstName).toBe("Jordan");
    expect(home.next.id).toBe(`a_${booked.id}`);
    expect(home.next).toMatchObject({
      status: "booked",
      statusLabel: "Booked",
      serviceName: "Skin fade",
      providerName: "Drick",
      providerImageUrl: "https://img.test/drick.jpg",
      canManage: true,
      timezone: "America/New_York",
    });
    expect(home.next.shop).toMatchObject({ name: "Alpha Cuts", timezone: "America/New_York" });
    // The card offers Directions, so the next appointment carries its address.
    expect(home.next.address).toBe("12 Main St, Brooklyn, NY 11201");
    expect(home.upcomingCount).toBe(3);

    const upcoming = (await get("/api/me/appointments", me.token)).body.upcoming;
    const req = upcoming.find((a: { id: string }) => a.id === `a_${requested.id}`);
    expect(req).toMatchObject({
      status: "requested",
      statusLabel: "Requested",
      statusDetail: "Waiting for Alpha Cuts to confirm",
      canManage: false,
    });
  });

  it("lists every shop the customer's records are at, with the shop's own words", async () => {
    const { me } = await regular();
    const home = (await get("/api/me/home", me.token)).body;
    expect(home.shops.map((s: { name: string }) => s.name)).toEqual(["Alpha Cuts", "Bravo Salon"]);
    const alpha = home.shops[0];
    expect(alpha).toMatchObject({ providerNoun: "barber", serviceNoun: "cut", rewardsEnabled: true, hasUpcoming: true });
    expect(home.shops[1]).toMatchObject({ providerNoun: "stylist", rewardsEnabled: false });
    // A barbershop AND a salon: the home refuses to call the stylist a barber.
    expect(home.vocabulary).toEqual({ providerNounPlural: "providers", serviceNoun: "visit" });
  });

  it("a customer of barbershops only is spoken to in barbershop words", async () => {
    const phone = randomPhone();
    await client(shopA, { phone });
    const me = await account({ phone });
    expect((await get("/api/me/home", me.token)).body.vocabulary).toEqual({
      providerNounPlural: "barbers",
      serviceNoun: "cut",
    });
  });

  it("shows rewards ONLY where the shop offers them - no zero card for the other", async () => {
    const { me } = await regular();
    const home = (await get("/api/me/home", me.token)).body;
    expect(home.rewards).toHaveLength(1);
    expect(home.rewards[0]).toMatchObject({
      shop: { name: "Alpha Cuts" },
      balance: 2,
      unit: "visits",
      next: { rewardName: "$10 off", cost: 5, remaining: 3 },
      readyRewards: [],
    });
  });
});

describe("history - native and synced, one list", () => {
  it("🔴 a completed native booking appears ONCE, and every status reads canonically", async () => {
    const { me, done, promoted } = await regular();
    const { past } = (await get("/api/me/appointments", me.token)).body;
    const ids = past.map((a: { id: string }) => a.id);
    expect(ids).toContain(`a_${done.id}`);
    expect(ids).not.toContain(`v_${promoted.id}`);
    const labels = past.map((a: { statusLabel: string }) => a.statusLabel);
    expect(labels).toEqual(expect.arrayContaining(["Completed", "Canceled", "No-show"]));
    expect(labels).not.toContain("Confirmed");
    // Newest first.
    const times = past.map((a: { startsAt: string }) => Date.parse(a.startsAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("names where each visit came from, and never invents a barber for a synced one", async () => {
    const { me, acuityNext } = await regular();
    const { upcoming, past } = (await get("/api/me/appointments", me.token)).body;
    const acuity = upcoming.find((a: { id: string }) => a.id === `v_${acuityNext.id}`);
    expect(acuity).toMatchObject({
      source: "acuity",
      status: "booked",
      providerName: null,
      canManage: false,
      manageNote: "To change this visit, contact Alpha Cuts.",
    });
    const square = past.find((a: { shop: { name: string } }) => a.shop.name === "Bravo Salon");
    expect(square).toMatchObject({ source: "square", status: "completed" });
    expect(past.some((a: { serviceName: string }) => a.serviceName === "Beard trim")).toBe(true);
  });

  it("a lapsed payment hold, and a request whose time passed unanswered, are not history", async () => {
    const phone = randomPhone();
    const c = await client(shopA, { phone });
    const lapsed = await appointment(shopA, c.id, {
      status: "PENDING",
      startsAt: from(2 * DAY),
      holdReason: "payment",
      holdExpiresAt: from(-60_000),
    });
    const stale = await appointment(shopA, c.id, { status: "PENDING", startsAt: from(-3 * DAY) });
    const me = await account({ phone });
    const { upcoming, past } = (await get("/api/me/appointments", me.token)).body;
    const all = [...upcoming, ...past].map((a: { id: string }) => a.id);
    expect(all).not.toContain(`a_${lapsed.id}`);
    expect(all).not.toContain(`a_${stale.id}`);
  });

  it("details carry the address and price, and 404 for anything not the customer's", async () => {
    const { me, booked } = await regular();
    const res = await get(`/api/me/appointments/a_${booked.id}`, me.token);
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({
      address: "12 Main St, Brooklyn, NY 11201",
      priceCents: 4500,
      durationMin: 30,
    });
    expect((await get("/api/me/appointments/a_doesnotexist123", me.token)).status).toBe(404);
  });
});

describe("🔴 isolation", () => {
  it("another customer at the SAME shop can read none of it - every door is a 404", async () => {
    const { me, booked, a1 } = await regular();
    const otherPhone = randomPhone();
    await client(shopA, { phone: otherPhone, firstName: "Taylor" });
    const other = await account({ phone: otherPhone });
    const alphaKey = (await get("/api/me/home", me.token)).body.shops[0].key;

    expect((await get(`/api/me/appointments/a_${booked.id}`, other.token)).status).toBe(404);
    expect((await get(`/api/me/appointments/a_${booked.id}/manage`, other.token)).status).toBe(404);
    expect((await get(`/api/me/shops/${alphaKey}/storefront`, other.token)).status).toBe(404);
    expect((await send("post", `/api/me/shops/${alphaKey}/not-me`, other.token)).status).toBe(404);

    const otherHome = JSON.stringify((await get("/api/me/home", other.token)).body);
    expect(otherHome).not.toContain(booked.id);
    expect(otherHome).not.toContain("Jordan");
    expect(otherHome).not.toContain(a1.magicToken);
  });

  it("🔴 private barber text never crosses the wire - on any /api/me reply", async () => {
    const { me, booked } = await regular();
    const replies = await Promise.all([
      get("/api/me/home", me.token),
      get("/api/me/appointments", me.token),
      get(`/api/me/appointments/a_${booked.id}`, me.token),
      get("/api/me/rewards", me.token),
      get("/api/me/notifications", me.token),
      get("/api/me", me.token),
    ]);
    for (const r of replies) {
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
    }
  });

  it("an archived record is never linked", async () => {
    const phone = randomPhone();
    const c = await client(shopA, { phone });
    await prisma.client.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    const me = await account({ phone });
    expect((await get("/api/me/home", me.token)).body.shops).toEqual([]);
  });

  it("a record whose phone the shop corrected drops off on the next read", async () => {
    const { me, b1 } = await regular();
    expect((await get("/api/me/home", me.token)).body.shops).toHaveLength(2);
    await prisma.client.update({ where: { id: b1.id }, data: { phone: randomPhone() } });
    const shops = (await get("/api/me/home", me.token)).body.shops.map((s: { name: string }) => s.name);
    expect(shops).toEqual(["Alpha Cuts"]);
    const link = await prisma.customerClientLink.findFirst({ where: { accountId: me.id, clientId: b1.id } });
    expect(link!.status).toBe("detached");
  });

  it("'This isn't me' removes a shop - and it stays removed", async () => {
    const { me } = await regular();
    const bravo = (await get("/api/me/home", me.token)).body.shops.find(
      (s: { name: string }) => s.name === "Bravo Salon",
    );
    expect((await send("post", `/api/me/shops/${bravo.key}/not-me`, me.token)).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const names = (await get("/api/me/home", me.token)).body.shops.map((s: { name: string }) => s.name);
      expect(names).toEqual(["Alpha Cuts"]);
    }
  });

  it("a record is ACTIVELY linked to one account - a second account matching it by email is declined", async () => {
    const phone = randomPhone();
    const email = `dup-${randomToken(6)}@test.local`.toLowerCase();
    const c = await client(shopA, { phone, email });
    const byPhone = await account({ phone });
    const byEmail = await account({ email });
    expect((await get("/api/me/home", byPhone.token)).body.shops).toHaveLength(1);
    expect((await get("/api/me/home", byEmail.token)).body.shops).toHaveLength(0);
    const active = await prisma.customerClientLink.count({ where: { clientId: c.id, status: "active" } });
    expect(active).toBe(1);
  });
});

describe("duplicate records at one shop", () => {
  it("show the shop once, never sum the balances, and say the other record holds punches", async () => {
    const phone = randomPhone();
    const email = `twin-${randomToken(6)}@test.local`.toLowerCase();
    const byPhone = await client(shopA, { phone });
    const byEmail = await client(shopA, { email: email.toUpperCase() }); // stored as typed
    const v = await visit(shopA, byPhone.id, { id: `manual:${randomToken(6)}`, status: "COMPLETED", at: from(-2 * DAY) });
    await prisma.punchLedger.create({
      data: { shopId: shopA, clientId: byPhone.id, visitId: v.id, punchesEarned: 1, runningBalance: 1, note: "visit" },
    });
    await prisma.punchLedger.create({
      data: { shopId: shopA, clientId: byEmail.id, punchesEarned: 3, runningBalance: 3, note: "bonus" },
    });
    const me = await account({ phone, email });

    const home = (await get("/api/me/home", me.token)).body;
    expect(home.shops).toHaveLength(1);
    expect(home.rewards[0].balance).toBe(1);
    const programs = (await get("/api/me/rewards", me.token)).body.programs;
    expect(programs).toHaveLength(1);
    expect(programs[0].otherProfileHasPunches).toBe(true);
    expect(programs[0].cards[0].balance).toBe(1);
  });
});

describe("rewards", () => {
  it("per shop, with the activity that built the balance", async () => {
    const { me } = await regular();
    const { programs } = (await get("/api/me/rewards", me.token)).body;
    expect(programs.map((p: { shop: { name: string } }) => p.shop.name)).toEqual(["Alpha Cuts"]);
    expect(programs[0].cards[0]).toMatchObject({ name: null, balance: 2, unit: "visits" });
    expect(programs[0].activity[0]).toMatchObject({ kind: "earned", punches: 2 });
    expect(programs[0].tier.visits).toBeGreaterThanOrEqual(1);
  });

  it("a ready reward is marked ready, and redemptions name the reward", async () => {
    const phone = randomPhone();
    const c = await client(shopA, { phone });
    // Distinct times: the activity list is newest-first.
    await prisma.punchLedger.create({
      data: { shopId: shopA, clientId: c.id, punchesEarned: 6, runningBalance: 6, note: "bonus", createdAt: from(-3 * DAY) },
    });
    const reward = await prisma.reward.findFirstOrThrow({ where: { shopId: shopA } });
    await prisma.punchLedger.create({
      data: {
        shopId: shopA,
        clientId: c.id,
        rewardId: reward.id,
        punchesRedeemed: 5,
        runningBalance: 1,
        note: "$10 off",
        createdAt: from(-2 * DAY),
      },
    });
    await prisma.punchLedger.create({
      data: { shopId: shopA, clientId: c.id, punchesEarned: 5, runningBalance: 6, note: "bonus", createdAt: from(-1 * DAY) },
    });
    const me = await account({ phone });
    const home = (await get("/api/me/home", me.token)).body;
    expect(home.rewards[0].readyRewards).toEqual(["$10 off"]);
    const activity = (await get("/api/me/rewards", me.token)).body.programs[0].activity;
    expect(activity.map((a: { kind: string }) => a.kind)).toEqual(["bonus", "redeemed", "bonus"]);
    expect(activity[1]).toMatchObject({ label: "$10 off", punches: -5 });
  });
});

describe("links out to the shop's own pages", () => {
  it("the storefront is the customer's own /r/ link; the manage page is the booking's own", async () => {
    const { me, a1, booked, acuityNext } = await regular();
    const alpha = (await get("/api/me/home", me.token)).body.shops[0];
    const store = await get(`/api/me/shops/${alpha.key}/storefront`, me.token);
    expect(store.status).toBe(200);
    expect(store.headers["cache-control"]).toBe("no-store");
    expect(store.body.url).toBe(`${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/r/${a1.magicToken}`);

    const manage = await get(`/api/me/appointments/a_${booked.id}/manage`, me.token);
    expect(manage.body.url).toMatch(new RegExp(`/book/manage/${booked.manageToken}$`));
    // A synced visit has no ChairBack manage page.
    expect((await get(`/api/me/appointments/v_${acuityNext.id}/manage`, me.token)).status).toBe(404);
  });
});

describe("notifications", () => {
  it("texts are per shop: turning one off touches that shop's record only", async () => {
    const { me, a1, b1 } = await regular();
    await prisma.client.updateMany({
      where: { id: { in: [a1.id, b1.id] } },
      data: { smsConsentAt: new Date(), smsConsentSource: "booking" },
    });
    const before = (await get("/api/me/notifications", me.token)).body;
    expect(before.texts.map((t: { on: boolean }) => t.on)).toEqual([true, true]);
    const alphaKey = before.texts.find((t: { shopName: string }) => t.shopName === "Alpha Cuts").key;

    const after = await send("patch", "/api/me/notifications", me.token, { texts: [{ key: alphaKey, on: false }] });
    expect(after.status).toBe(200);
    const [a, b] = await Promise.all([
      prisma.client.findUniqueOrThrow({ where: { id: a1.id } }),
      prisma.client.findUniqueOrThrow({ where: { id: b1.id } }),
    ]);
    expect(a.optedOut).toBe(true);
    expect(a.optOutSource).toBe("client_self_serve");
    expect(b.optedOut).toBe(false);
  });

  it("a key that isn't the customer's own is a 404, and changes nothing", async () => {
    const me = await account({ phone: randomPhone() });
    const res = await send("patch", "/api/me/notifications", me.token, { texts: [{ key: "someone-elses", on: false }] });
    expect(res.status).toBe(404);
  });
});

describe("push reaches the customer from every shop", () => {
  it("🔴 one signed-in phone hears from BOTH shops - and not from a record it isn't linked to", async () => {
    const { me, a1, b1 } = await regular();
    const token = `ExponentPushToken[${randomToken(12)}]`;
    expect((await send("post", "/api/me/devices", me.token, { expoPushToken: token, platform: "ios" })).status).toBe(200);
    // Linking happens on read; the device is registered after the home loaded.
    await get("/api/me/home", me.token);

    const delivered: string[] = [];
    __setExpoSenderForTests({ send: async (t) => void delivered.push(t) });
    const payload = { title: "t", body: "b", url: "https://x.test" };
    await sendPushToClient({ shopId: shopA, clientId: a1.id, payload });
    await sendPushToClient({ shopId: shopB, clientId: b1.id, payload });
    const stranger = await client(shopA, { phone: randomPhone() });
    await sendPushToClient({ shopId: shopA, clientId: stranger.id, payload });
    expect(delivered).toEqual([token, token]);
  });

  it("the customer's own push switch is honoured", async () => {
    const { me, a1 } = await regular();
    const token = `ExponentPushToken[${randomToken(12)}]`;
    await send("post", "/api/me/devices", me.token, { expoPushToken: token, platform: "ios" });
    await send("patch", "/api/me/notifications", me.token, { push: false });
    const delivered: string[] = [];
    __setExpoSenderForTests({ send: async (t) => void delivered.push(t) });
    await sendPushToClient({ shopId: shopA, clientId: a1.id, payload: { title: "t", body: "b", url: "u" } });
    expect(delivered).toEqual([]);
  });
});

describe("profile and deletion", () => {
  it("the customer names themselves; the shop's record is not touched", async () => {
    const { me, a1 } = await regular();
    const res = await send("patch", "/api/me", me.token, { firstName: "  Jo  " });
    expect(res.body.profile.firstName).toBe("Jo");
    expect((await get("/api/me/home", me.token)).body.firstName).toBe("Jo");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: a1.id } })).firstName).toBe("Jordan");
  });

  it("deleting the account ends every session and leaves the shops' records alone", async () => {
    const { me, a1 } = await regular();
    expect((await send("delete", "/api/me", me.token)).status).toBe(200);
    expect((await get("/api/me/home", me.token)).status).toBe(401);
    expect(await prisma.customerAccount.findUnique({ where: { id: me.id } })).toBeNull();
    expect(await prisma.customerClientLink.count({ where: { accountId: me.id } })).toBe(0);
    expect(await prisma.client.findUnique({ where: { id: a1.id } })).not.toBeNull();
  });
});

describe("the demo", () => {
  it("is read-only - every write is refused", async () => {
    const demo = await account({ isDemo: true, firstName: "Alex" });
    expect((await get("/api/me/home", demo.token)).status).toBe(200);
    const write = await send("patch", "/api/me", demo.token, { firstName: "Hacked" });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe("demo_read_only");
    expect((await send("post", "/api/me/devices", demo.token, { expoPushToken: "ExponentPushToken[x1234567890]", platform: "ios" })).status).toBe(403);
  });

  it("a real token can never claim to be the demo, nor the demo a real account", async () => {
    const real = await account({ phone: randomPhone() });
    const forged = mintCustomerSession(real.id, 0, { demo: true });
    expect((await get("/api/me/home", forged)).status).toBe(401);
  });
});
