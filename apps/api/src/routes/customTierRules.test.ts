import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, rulesFromThresholds } from "@chairback/config";
import { createApp } from "../app.js";
import { recomputeCadence } from "../engines/cadence.js";
import { runTierRecompute } from "../engines/tierRecomputeJob.js";

/**
 * CUSTOM TIER RULES - "Gold spends a specific amount AND comes in a specific
 * number of times a month."
 *
 * The rules under test: money is counted the way revenue counts it (a no-show's
 * ticket is not money); a window-based tier falls away with time, which only
 * the daily job notices; every writer - the rules PATCH, a completed visit,
 * the daily job - lands on the same tier; the customer's page describes the
 * same rules; and only an owner or manager can change the ladder.
 */

const app = createApp();
const DAY = 86_400_000;
const password = "supersecret123";
const emails: string[] = [];
let shopId = "";
let ownerCookie = "";
let barberCookie = "";

const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function client(name: string, visits: { daysAgo: number; price: number; status?: "COMPLETED" | "NO_SHOW" }[]) {
  const c = await prisma.client.create({
    data: { shopId, acuityClientKey: `k-${randomToken(8)}`, magicToken: randomToken(), firstName: name, source: "manual" },
    select: { id: true, magicToken: true },
  });
  for (const v of visits) {
    await prisma.visit.create({
      data: {
        shopId,
        clientId: c.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: daysAgo(v.daysAgo),
        status: v.status ?? "COMPLETED",
        price: v.price,
      },
    });
  }
  return c;
}

const tierOf = (id: string) =>
  prisma.client.findUnique({ where: { id }, select: { loyaltyTier: true } }).then((c) => c?.loyaltyTier ?? null);

/** Bronze: a visit. Silver: $100 in the last 3 months. Gold: 2 visits in the last 30 days AND $200 all time. */
const RULES = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: null, spend: { minCents: 10_000, windowDays: 90 }, match: "all" },
  GOLD: { visits: { min: 2, windowDays: 30 }, spend: { minCents: 20_000, windowDays: 0 }, match: "all" },
};

let regular: { id: string; magicToken: string };
let bigSpender: { id: string; magicToken: string };
let cheapRegular: { id: string; magicToken: string };
let noShow: { id: string; magicToken: string };
let nobody: { id: string; magicToken: string };

beforeAll(async () => {
  const owner = await signup("rules-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Rules Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } });

  const barber = await signup("rules-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER" } });

  regular = await client("Regular", [
    { daysAgo: 1, price: 120 },
    { daysAgo: 2, price: 120 },
  ]);
  bigSpender = await client("Big", [{ daysAgo: 60, price: 300 }]);
  cheapRegular = await client("Cheap", [
    { daysAgo: 3, price: 20 },
    { daysAgo: 5, price: 20 },
    { daysAgo: 7, price: 20 },
  ]);
  noShow = await client("NoShow", [
    { daysAgo: 60, price: 500, status: "NO_SHOW" },
    { daysAgo: 1, price: 10 },
  ]);
  nobody = await client("Nobody", []);
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("PATCH /api/shops/me { tierRules }", () => {
  it("🔴 stores the rules and re-stamps every client by visits AND money in the same request", async () => {
    const res = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierRules: RULES });
    expect(res.status).toBe(200);
    expect(res.body.tierRules).toEqual(RULES);
    expect(res.body.tierRulesCustom).toBe(true);
    expect(res.body.tierRecompute).toEqual({ clients: 5, changed: 4 });

    expect(await tierOf(regular.id)).toBe("GOLD"); // 2 this month, $240
    expect(await tierOf(bigSpender.id)).toBe("SILVER"); // $300 two months ago, not in lately
    expect(await tierOf(cheapRegular.id)).toBe("BRONZE"); // in often, $60
    // 🔴 The $500 no-show earned nothing - counting its ticket would make this Silver.
    expect(await tierOf(noShow.id)).toBe("BRONZE");
    expect(await tierOf(nobody.id)).toBeNull();
  });
});

describe("what the customer is shown", () => {
  it("the next tier's requirements, what is left, and the whole ladder - from the same rules", async () => {
    const res = await request(app).get(`/api/rewards/${bigSpender.magicToken}`);
    expect(res.status).toBe(200);
    const loyalty = res.body.loyalty;
    expect(loyalty.tier).toBe("SILVER");
    expect(loyalty.nextTier).toMatchObject({
      label: "Gold",
      match: "all",
      summary: "2 more visits in the last 30 days to reach Gold",
      visitsAway: 2,
    });
    expect(loyalty.nextTier.requirements).toEqual([
      { kind: "visits", have: 0, need: 2, windowDays: 30, met: false, text: "0 of 2 visits in the last 30 days" },
      { kind: "spend", have: 30_000, need: 20_000, windowDays: 0, met: true, text: "$300 spent" },
    ]);
    // Visits 0 of 2; money already done.
    expect(loyalty.fraction).toBeCloseTo(0.5, 10);
    expect(loyalty.ladder.map((r: { tier: string; takes: string }) => [r.tier, r.takes])).toEqual([
      ["BRONZE", "1 visit"],
      ["SILVER", "$100 spent in the last 3 months"],
      ["GOLD", "2 visits in the last 30 days and $200 spent"],
    ]);
  });
});

describe("every writer lands on the same tier", () => {
  it("a completed visit stamps by the shop's rules - money included", async () => {
    await prisma.visit.create({
      data: {
        shopId,
        clientId: cheapRegular.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: daysAgo(1),
        status: "COMPLETED",
        price: 150,
      },
    });
    await recomputeCadence(shopId, cheapRegular.id);
    // 4 visits this month, $210 all time.
    expect(await tierOf(cheapRegular.id)).toBe("GOLD");
  });

  it("🔴 the daily job takes tiers away once visits and money age out of their windows", async () => {
    const r = await runTierRecompute({ shopId, now: new Date(Date.now() + 31 * DAY) });
    expect(r).toMatchObject({ shops: 1, failed: 0, changed: 3 });
    // Nothing in the last 30 days any more; recent money still makes them Silver.
    expect(await tierOf(regular.id)).toBe("SILVER");
    expect(await tierOf(cheapRegular.id)).toBe("SILVER");
    // The $300 is now 91 days old - outside Silver's 3 months.
    expect(await tierOf(bigSpender.id)).toBe("BRONZE");
    expect(await tierOf(noShow.id)).toBe("BRONZE");
  });

  it("and puts them back when the job runs at today's date again", async () => {
    const r = await runTierRecompute({ shopId });
    expect(r.changed).toBe(3);
    expect(await tierOf(regular.id)).toBe("GOLD");
    expect(await tierOf(bigSpender.id)).toBe("SILVER");
  });
});

describe("refusals change nothing", () => {
  it("a higher tier asking for less money than the one below it", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({
        tierRules: {
          ...RULES,
          GOLD: { visits: null, spend: { minCents: 5_000, windowDays: 90 }, match: "all" },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_tier_rules", reason: "easier_than_below", tier: "GOLD" });
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true } });
    expect(shop?.tierRules).toEqual({ version: 1, tiers: RULES });
    expect(await tierOf(regular.id)).toBe("GOLD");
  });

  it("rules and thresholds in one request - two answers to one question", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierRules: RULES, tierThresholds: { BRONZE: 1, SILVER: 6, GOLD: 12 } });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("rules_and_thresholds");
  });

  it("a window the page doesn't offer", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierRules: { ...RULES, BRONZE: { visits: { min: 1, windowDays: 31 }, spend: null, match: "all" } } });
    expect(res.status).toBe(400);
  });
});

describe("🔴 the ladder is an owner's or manager's call", () => {
  it("a barber seat cannot change what a tier takes or what it promises", async () => {
    for (const body of [
      { tierRules: RULES },
      { tierThresholds: { BRONZE: 1, SILVER: 6, GOLD: 12 } },
      { tierPerks: { GOLD: "Free beard trim" } },
    ]) {
      const res = await request(app).patch("/api/shops/me").set("Cookie", barberCookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true, tierPerks: true } });
    expect(shop?.tierRules).toEqual({ version: 1, tiers: RULES });
    expect(shop?.tierPerks).toBeNull();
  });

  it("while the rest of their settings still save", async () => {
    const res = await request(app).patch("/api/shops/me").set("Cookie", barberCookie).send({ bio: "Walk-ins welcome" });
    expect(res.status).toBe(200);
  });
});

describe("going back to plain visit counts", () => {
  it("thresholds replace the custom rules, and the badges follow", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierThresholds: { BRONZE: 1, SILVER: 3, GOLD: 12 } });
    expect(res.status).toBe(200);
    expect(res.body.tierRulesCustom).toBe(false);
    expect(res.body.tierRules).toEqual(rulesFromThresholds({ BRONZE: 1, SILVER: 3, GOLD: 12 }));
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true } });
    expect(shop?.tierRules).toBeNull();

    expect(await tierOf(cheapRegular.id)).toBe("SILVER"); // 4 visits
    expect(await tierOf(regular.id)).toBe("BRONZE"); // 2 visits
    expect(await tierOf(bigSpender.id)).toBe("BRONZE"); // money no longer counts
  });

  it("the daily job leaves a shop alone when time cannot change its tiers", async () => {
    expect(await runTierRecompute({ shopId })).toMatchObject({ shops: 0, changed: 0 });
    // Custom rules, but lifetime visits only: still nothing for time to move.
    const lifetimeOnly = rulesFromThresholds({ BRONZE: 1, SILVER: 3, GOLD: 12 });
    const res = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierRules: lifetimeOnly });
    expect(res.status).toBe(200);
    expect(res.body.tierRulesCustom).toBe(true);
    expect(await runTierRecompute({ shopId })).toMatchObject({ shops: 0, changed: 0 });
  });
});
