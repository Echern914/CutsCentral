import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { ACTIVE_SHOP_COOKIE_NAME, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { recomputeCadence } from "../engines/cadence.js";
import { runTierRecompute } from "../engines/tierRecomputeJob.js";

/**
 * TIERS BY AVERAGE TICKET, AND THE PREVIEW BEFORE SAVING.
 *
 * A barber asked for tiers by "avg ticket cost". The owner now sets an
 * average-ticket requirement beside visits and money spent, and sees - BEFORE
 * saving - how many clients would hold each tier under the draft against how
 * many hold it now.
 *
 * 🔴 The preview is READ-ONLY: no rules stored, no badge moved, no punch, no
 * message. And it is the save's own arithmetic: the "would move" it shows is
 * the "moved" the save then reports.
 */

const app = createApp();
const DAY = 86_400_000;
const password = "supersecret123";
const emails: string[] = [];
let shopId = "";
let otherShopId = "";
let ownerCookie = "";
let barberCookie = "";
let otherOwnerCookie = "";
let shoplessCookie = "";

const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function client(inShop: string, name: string, prices: (number | null)[], floor?: "GOLD") {
  const c = await prisma.client.create({
    data: {
      shopId: inShop,
      acuityClientKey: `k-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: name,
      source: "manual",
      ...(floor ? { loyaltyTierFloor: floor, loyaltyTier: floor } : {}),
    },
    select: { id: true, magicToken: true },
  });
  for (const [i, price] of prices.entries()) {
    await prisma.visit.create({
      data: {
        shopId: inShop,
        clientId: c.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: daysAgo(5 + i),
        status: "COMPLETED",
        price,
      },
    });
  }
  return c;
}

const tierOf = (id: string) =>
  prisma.client.findUnique({ where: { id }, select: { loyaltyTier: true } }).then((c) => c?.loyaltyTier ?? null);

/** Bronze: a visit. Silver: a $40 average over 3 months. Gold: a $70 one. */
const AVG_RULES = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: null, spend: null, avgTicket: { minCents: 4_000, windowDays: 90 }, match: "all" },
  GOLD: { visits: null, spend: null, avgTicket: { minCents: 7_000, windowDays: 90 }, match: "all" },
};

let high: { id: string; magicToken: string };
let mid: { id: string; magicToken: string };
let low: { id: string; magicToken: string };
let unknown: { id: string; magicToken: string };
let nobody: { id: string; magicToken: string };
let raised: { id: string; magicToken: string };

/** Everything a tier change must never write, for this shop. */
async function sideEffects(id: string) {
  return {
    punches: await prisma.punchLedger.count({ where: { shopId: id } }),
    nudges: await prisma.nudge.count({ where: { shopId: id } }),
    emailIntents: await prisma.emailIntent.count({ where: { shopId: id } }),
    emailDeliveries: await prisma.emailDelivery.count({ where: { shopId: id } }),
  };
}

beforeAll(async () => {
  const owner = await signup("avgprev-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Avg Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } });

  const barber = await signup("avgprev-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER" } });

  const other = await signup("avgprev-other");
  otherOwnerCookie = other.cookie;
  const otherShop = await request(app)
    .post("/api/shops")
    .set("Cookie", otherOwnerCookie)
    .send({ name: "Other Cuts", smsAttested: true });
  expect(otherShop.status).toBe(201);
  otherShopId = otherShop.body.id as string;
  await client(otherShopId, "Elsewhere", [500]);

  shoplessCookie = (await signup("avgprev-shopless")).cookie;

  high = await client(shopId, "High", [80, 80]); // $80 average
  mid = await client(shopId, "Mid", [40, 60]); // $50
  low = await client(shopId, "Low", [20, 20]); // $20
  unknown = await client(shopId, "Unknown", [null, null]); // no average: Bronze by visits
  nobody = await client(shopId, "Nobody", []);
  raised = await client(shopId, "Raised", [20], "GOLD"); // set to Gold by hand
});

afterAll(async () => {
  for (const id of [shopId, otherShopId]) if (id) await prisma.shop.deleteMany({ where: { id } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

const preview = (cookie: string | string[], tierRules: unknown) =>
  request(app)
    .post("/api/shops/me/tier-rules/preview")
    .set("Cookie", typeof cookie === "string" ? [cookie] : cookie)
    .send({ tierRules });

describe("POST /api/shops/me/tier-rules/preview", () => {
  it("counts each tier now and under the draft, and how many would move", async () => {
    const res = await preview(ownerCookie, AVG_RULES);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clients: 6,
      current: { NONE: 5, BRONZE: 0, SILVER: 0, GOLD: 1 },
      // High -> Gold; Mid -> Silver; Low and Unknown -> Bronze (no average is
      // not $0, and not met); Nobody stays none; Raised keeps the Gold set by hand.
      proposed: { NONE: 1, BRONZE: 2, SILVER: 1, GOLD: 2 },
      wouldMove: 4,
    });
  });

  it("🔴 stores nothing: no rules, no badge, no punch, no message", async () => {
    const before = await sideEffects(shopId);
    const res = await preview(ownerCookie, AVG_RULES);
    expect(res.status).toBe(200);
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true } });
    expect(shop?.tierRules).toBeNull();
    for (const c of [high, mid, low, unknown, nobody]) expect(await tierOf(c.id)).toBeNull();
    expect(await tierOf(raised.id)).toBe("GOLD");
    expect(await sideEffects(shopId)).toEqual(before);
    expect(before).toEqual({ punches: 0, nudges: 0, emailIntents: 0, emailDeliveries: 0 });
  });

  it("refuses rules the save would refuse, naming the tier", async () => {
    const res = await preview(ownerCookie, {
      ...AVG_RULES,
      GOLD: { visits: null, spend: null, avgTicket: { minCents: 3_000, windowDays: 90 }, match: "all" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_tier_rules", reason: "easier_than_below", tier: "GOLD" });
    expect((await preview(ownerCookie, { BRONZE: AVG_RULES.BRONZE })).status).toBe(400);
  });

  it("🔴 a barber seat cannot preview the ladder", async () => {
    const res = await preview(barberCookie, AVG_RULES);
    expect(res.status).toBe(403);
  });

  it("🔴 another shop's numbers never leak: the session's shop, whatever the cookie asks for", async () => {
    // A user with no shop at all.
    const none = await preview(shoplessCookie, AVG_RULES);
    expect(none.status).toBe(404);
    // Another shop's owner pointing the active-shop cookie at this shop gets
    // their OWN shop's counts (one client, $500) - never this shop's six.
    const res = await preview([otherOwnerCookie, `${ACTIVE_SHOP_COOKIE_NAME}=${shopId}`], AVG_RULES);
    expect(res.status).toBe(200);
    expect(res.body.clients).toBe(1);
    expect(res.body.proposed).toEqual({ NONE: 0, BRONZE: 0, SILVER: 0, GOLD: 1 });
  });
});

describe("saving average-ticket rules", () => {
  it("🔴 moves exactly the badges the preview said, and writes no punch or message", async () => {
    const before = await sideEffects(shopId);
    const shown = (await preview(ownerCookie, AVG_RULES)).body;

    const res = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierRules: AVG_RULES });
    expect(res.status).toBe(200);
    expect(res.body.tierRules).toEqual(AVG_RULES);
    expect(res.body.tierRecompute).toEqual({ clients: shown.clients, changed: shown.wouldMove });

    expect(await tierOf(high.id)).toBe("GOLD");
    expect(await tierOf(mid.id)).toBe("SILVER");
    expect(await tierOf(low.id)).toBe("BRONZE");
    expect(await tierOf(unknown.id)).toBe("BRONZE");
    expect(await tierOf(nobody.id)).toBeNull();
    expect(await tierOf(raised.id)).toBe("GOLD");

    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true } });
    expect(shop?.tierRules).toEqual({ version: 1, tiers: AVG_RULES });
    expect(await sideEffects(shopId)).toEqual(before);

    // Previewing the rules now in force: nothing would move.
    const again = await preview(ownerCookie, AVG_RULES);
    expect(again.body.wouldMove).toBe(0);
    expect(again.body.current).toEqual(again.body.proposed);
  });

  it("the customer's page states the average the same way", async () => {
    const res = await request(app).get(`/api/rewards/${mid.magicToken}`);
    expect(res.status).toBe(200);
    const loyalty = res.body.loyalty;
    expect(loyalty.tier).toBe("SILVER");
    expect(loyalty.nextTier.requirements).toEqual([
      {
        kind: "avgTicket",
        have: 5_000,
        need: 7_000,
        windowDays: 90,
        met: false,
        text: "$50 of a $70 average ticket in the last 3 months",
      },
    ]);
    expect(loyalty.nextTier.summary).toBe("an average ticket of $70 in the last 3 months to reach Gold");
    expect(loyalty.ladder.map((r: { tier: string; takes: string }) => [r.tier, r.takes])).toEqual([
      ["BRONZE", "1 visit"],
      ["SILVER", "an average ticket of $40 in the last 3 months"],
      ["GOLD", "an average ticket of $70 in the last 3 months"],
    ]);
  });

  it("🔴 a completed visit re-stamps by the average, and the daily job keeps it", async () => {
    // Low: $20, $20, now $200 -> an $80 average -> Gold.
    await prisma.visit.create({
      data: {
        shopId,
        clientId: low.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: daysAgo(1),
        status: "COMPLETED",
        price: 200,
      },
    });
    const before = await sideEffects(shopId);
    await recomputeCadence(shopId, low.id);
    expect(await tierOf(low.id)).toBe("GOLD");
    // An average moves on refunds, so the shop is on the daily re-check.
    expect(await runTierRecompute({ shopId })).toMatchObject({ shops: 1, failed: 0, changed: 0 });
    expect(await tierOf(low.id)).toBe("GOLD");
    expect((await sideEffects(shopId)).punches).toBe(before.punches);
  });

  it("a page that predates the measure still saves (no avgTicket key at all)", async () => {
    const OLD = {
      BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
      SILVER: { visits: { min: 2, windowDays: 0 }, spend: null, match: "all" },
      GOLD: { visits: { min: 3, windowDays: 0 }, spend: null, match: "all" },
    };
    const res = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierRules: OLD });
    expect(res.status).toBe(200);
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true } });
    // Stored as before the measure existed - not even an `avgTicket: null`.
    expect(shop?.tierRules).toEqual({ version: 1, tiers: OLD });
    const tiers = (shop?.tierRules as { tiers: Record<string, object> }).tiers;
    for (const k of ["BRONZE", "SILVER", "GOLD"]) expect("avgTicket" in tiers[k]!).toBe(false);
  });
});
