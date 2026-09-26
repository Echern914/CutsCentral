import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { parseTierRules, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { recomputeCadence } from "../engines/cadence.js";
import { recomputeLoyaltyTiers } from "../engines/loyaltyTierRecompute.js";
import { buildLoyaltyView, loadLoyaltyInputs } from "../services/loyaltyView.js";

/**
 * RAISING A CLIENT'S TIER BY HAND - "the barber should be able to press it
 * and, if they want, move them up a tier on their own."
 *
 * The rules under test: UP ONLY, AND IT STICKS. A tier can be raised only
 * above what the client EARNED; once raised, every writer of the stored tier
 * (a completed visit, a rule change, the daily recompute) keeps the client at
 * it or lifts them past it, never below; "Back to automatic" hands them back to
 * the rules; the customer sees the tier the shop gave them; and only an owner
 * or manager of THIS shop can do any of it.
 *
 * This shop's ladder: Bronze 1 visit, Silver 3, Gold 5 (lifetime).
 */

const app = createApp();
const DAY = 86_400_000;
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];
let shopId = "";
let otherShopId = "";
let ownerCookie = "";
let barberCookie = "";
let managerCookie = "";

const THRESHOLDS = { BRONZE: 1, SILVER: 3, GOLD: 5 };

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function makeShop(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  shopIds.push(res.body.id as string);
  await prisma.shop.update({ where: { id: res.body.id }, data: { rewardsEnabled: true } });
  return res.body.id as string;
}

/** A client at `shop` with `visits` completed visits, stamped the way a real visit stamps them. */
async function client(shop: string, visits: number) {
  const c = await prisma.client.create({
    data: {
      shopId: shop,
      acuityClientKey: `k-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: `Tier${randomToken(4)}`,
      source: "manual",
    },
    select: { id: true, magicToken: true },
  });
  for (let i = 0; i < visits; i++) await addVisit(shop, c.id, 40 + i);
  await recomputeCadence(shop, c.id);
  return c;
}

function addVisit(shop: string, clientId: string, daysAgo: number) {
  return prisma.visit.create({
    data: {
      shopId: shop,
      clientId,
      acuityAppointmentId: `a-${randomToken(8)}`,
      scheduledAt: new Date(Date.now() - daysAgo * DAY),
      status: "COMPLETED",
      price: 30,
    },
  });
}

const row = (id: string) =>
  prisma.client.findUnique({
    where: { id },
    select: { loyaltyTier: true, loyaltyTierFloor: true, loyaltyTierFloorSetAt: true },
  });

const setTier = (cookie: string, id: string, body: unknown) =>
  request(app).post(`/api/dashboard/clients/${id}/tier`).set("Cookie", cookie).send(body as object);

const detail = async (id: string) => {
  const res = await request(app).get(`/api/dashboard/clients/${id}`).set("Cookie", ownerCookie);
  expect(res.status).toBe(200);
  return res.body;
};

const shopRules = async () => {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { tierRules: true, tierThresholds: true } });
  return parseTierRules(shop?.tierRules, shop?.tierThresholds);
};

beforeAll(async () => {
  const owner = await signup("tierhand-owner");
  ownerCookie = owner.cookie;
  shopId = await makeShop(ownerCookie, `Tier Hand ${randomToken(4)}`);
  const patch = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierThresholds: THRESHOLDS });
  expect(patch.status).toBe(200);

  const barber = await signup("tierhand-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER" } });
  const manager = await signup("tierhand-manager");
  managerCookie = manager.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: manager.userId, role: "MANAGER" } });

  const other = await signup("tierhand-other");
  otherShopId = await makeShop(other.cookie, `Other Tier ${randomToken(4)}`);
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("POST /api/dashboard/clients/:id/tier - raising", () => {
  it("🔴 raises the STORED tier, so every list, audience and opening sees it, and the page says it was set by hand", async () => {
    const c = await client(shopId, 1);
    expect((await row(c.id))?.loyaltyTier).toBe("BRONZE");
    expect((await detail(c.id)).tier).toMatchObject({ current: "BRONZE", earned: "BRONZE", setByHand: false, floor: null });

    const res = await setTier(ownerCookie, c.id, { tier: "SILVER" });
    expect(res.status).toBe(200);
    expect(res.body.tier).toMatchObject({
      current: "SILVER",
      label: "Silver",
      earned: "BRONZE",
      earnedLabel: "Bronze",
      setByHand: true,
      floor: "SILVER",
    });
    // The road ahead starts from the tier they now hold.
    expect(res.body.tier.next).toMatchObject({ label: "Gold", summary: "4 more visits to Gold" });

    const stored = await row(c.id);
    expect(stored?.loyaltyTier).toBe("SILVER");
    expect(stored?.loyaltyTierFloor).toBe("SILVER");
    expect(stored?.loyaltyTierFloorSetAt).toBeInstanceOf(Date);
    // The clients list's tier filter reads the stored column.
    const list = await request(app).get("/api/dashboard/clients?tier=SILVER").set("Cookie", ownerCookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(c.id);

    // 🔴 The client page reads the floor too - the same view the setter answered with.
    expect((await detail(c.id)).tier).toEqual(res.body.tier);
  });

  it("🔴 refuses a tier at or below what they EARNED, and writes nothing", async () => {
    const c = await client(shopId, 3); // earned Silver
    for (const tier of ["SILVER", "BRONZE"]) {
      const res = await setTier(ownerCookie, c.id, { tier });
      expect(res.status, tier).toBe(400);
      expect(res.body.error).toBe("not_higher");
      expect(res.body.tier).toMatchObject({ current: "SILVER", earned: "SILVER", setByHand: false });
    }
    expect(await row(c.id)).toEqual({ loyaltyTier: "SILVER", loyaltyTierFloor: null, loyaltyTierFloorSetAt: null });
    expect((await detail(c.id)).tier).toMatchObject({ current: "SILVER", setByHand: false, floor: null });
  });

  it("measures 'higher' against what they earned, not what they were raised to", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "BRONZE" })).body.error).toBe("not_higher");
    expect((await setTier(ownerCookie, c.id, { tier: "GOLD" })).status).toBe(200);
    expect((await row(c.id))?.loyaltyTier).toBe("GOLD");
  });

  it("a client with no tier yet can be raised straight to one", async () => {
    const c = await client(shopId, 0);
    expect((await row(c.id))?.loyaltyTier).toBeNull();
    const res = await setTier(ownerCookie, c.id, { tier: "BRONZE" });
    expect(res.status).toBe(200);
    expect(res.body.tier).toMatchObject({ current: "BRONZE", earned: null, earnedLabel: null, setByHand: true });
    expect((await row(c.id))?.loyaltyTier).toBe("BRONZE");
  });
});

describe("Back to automatic", () => {
  it("🔴 null clears the floor and restores the tier they earned", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "GOLD" })).status).toBe(200);
    expect((await row(c.id))?.loyaltyTier).toBe("GOLD");

    const res = await setTier(ownerCookie, c.id, { tier: null });
    expect(res.status).toBe(200);
    expect(res.body.tier).toMatchObject({ current: "BRONZE", earned: "BRONZE", setByHand: false, floor: null });
    expect(await row(c.id)).toMatchObject({ loyaltyTier: "BRONZE", loyaltyTierFloor: null });
  });

  it("a client who never had a floor stays exactly where they were", async () => {
    const c = await client(shopId, 3);
    const res = await setTier(ownerCookie, c.id, { tier: null });
    expect(res.status).toBe(200);
    expect(await row(c.id)).toMatchObject({ loyaltyTier: "SILVER", loyaltyTierFloor: null });
  });
});

describe("🔴 it sticks - every other writer of the stored tier keeps the floor", () => {
  it("a completed visit re-stamps the tier and keeps them at the floor", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "SILVER" })).status).toBe(200);

    await addVisit(shopId, c.id, 2);
    await recomputeCadence(shopId, c.id); // 2 visits: earned Bronze
    expect(await row(c.id)).toMatchObject({ loyaltyTier: "SILVER", loyaltyTierFloor: "SILVER" });
  });

  it("but visits can still lift them PAST the floor - and the floor then sleeps rather than showing", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "SILVER" })).status).toBe(200);
    for (let i = 0; i < 4; i++) await addVisit(shopId, c.id, 3 + i);
    await recomputeCadence(shopId, c.id); // 5 visits: earned Gold
    expect(await row(c.id)).toMatchObject({ loyaltyTier: "GOLD", loyaltyTierFloor: "SILVER" });
    expect((await detail(c.id)).tier).toMatchObject({ current: "GOLD", earned: "GOLD", setByHand: false, floor: "SILVER" });
  });

  it("the recompute (rule change and daily job) keeps the floor", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "SILVER" })).status).toBe(200);
    const r = await recomputeLoyaltyTiers(shopId, await shopRules());
    expect(await row(c.id)).toMatchObject({ loyaltyTier: "SILVER", loyaltyTierFloor: "SILVER" });
    expect(r.changed).toBe(0);
  });

  it("a harder ladder takes others down, and a raised client only down TO their floor", async () => {
    const raised = await client(shopId, 1);
    const plain = await client(shopId, 1);
    expect((await setTier(ownerCookie, raised.id, { tier: "SILVER" })).status).toBe(200);

    try {
      // Bronze now takes 2 visits: one visit earns nothing.
      const res = await request(app)
        .patch("/api/shops/me")
        .set("Cookie", ownerCookie)
        .send({ tierThresholds: { BRONZE: 2, SILVER: 3, GOLD: 5 } });
      expect(res.status).toBe(200);
      expect((await row(plain.id))?.loyaltyTier).toBeNull();
      expect(await row(raised.id)).toMatchObject({ loyaltyTier: "SILVER", loyaltyTierFloor: "SILVER" });
      expect((await detail(raised.id)).tier).toMatchObject({ current: "SILVER", earned: null, setByHand: true });
    } finally {
      // Put the ladder back even when an assertion above failed, so one broken
      // expectation cannot cascade into every test after it.
      const back = await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ tierThresholds: THRESHOLDS });
      expect(back.status).toBe(200);
    }
  });

  it("merging two records keeps the higher floor", async () => {
    const winner = await client(shopId, 1);
    const loser = await client(shopId, 1);
    expect((await setTier(ownerCookie, loser.id, { tier: "GOLD" })).status).toBe(200);
    const res = await request(app)
      .post(`/api/dashboard/clients/${winner.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ loserId: loser.id });
    expect(res.status).toBe(200);
    // 2 visits between them earn Bronze; the Gold the shop gave the person stays.
    expect(await row(winner.id)).toMatchObject({ loyaltyTier: "GOLD", loyaltyTierFloor: "GOLD" });
  });
});

describe("what the customer is shown", () => {
  it("🔴 their rewards page shows the tier the shop gave them, and the road from it", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "SILVER" })).status).toBe(200);
    const res = await request(app).get(`/api/rewards/${c.magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.loyalty).toMatchObject({ tier: "SILVER", label: "Silver" });
    expect(res.body.loyalty.nextTier).toMatchObject({ label: "Gold", visitsAway: 4 });
  });

  it("and so does the My ChairBack app, which loads the same inputs", async () => {
    const c = await client(shopId, 1);
    expect((await setTier(ownerCookie, c.id, { tier: "GOLD" })).status).toBe(200);
    const rules = await shopRules();
    const inputs = await runWithShop(shopId, (tx) => loadLoyaltyInputs(tx, shopId, c.id, rules, new Date()));
    expect(inputs.tierFloor).toBe("GOLD");
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { tierRules: true, tierThresholds: true, tierPerks: true },
    });
    const view = buildLoyaltyView(shop!, inputs);
    expect(view.loyalty).toMatchObject({ tier: "GOLD", nextTier: null, fraction: 1 });
  });
});

describe("🔴 only an owner or manager of THIS shop", () => {
  it("another shop's client is a plain 404, and is not touched", async () => {
    const theirs = await client(otherShopId, 1);
    const res = await setTier(ownerCookie, theirs.id, { tier: "GOLD" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(await row(theirs.id)).toEqual({ loyaltyTier: "BRONZE", loyaltyTierFloor: null, loyaltyTierFloorSetAt: null });
  });

  it("an id that is nobody's is a 404", async () => {
    expect((await setTier(ownerCookie, "no-such-client", { tier: "GOLD" })).status).toBe(404);
  });

  it("a barber seat is refused, and nothing is written", async () => {
    const c = await client(shopId, 1);
    const res = await setTier(barberCookie, c.id, { tier: "GOLD" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
    expect(await row(c.id)).toEqual({ loyaltyTier: "BRONZE", loyaltyTierFloor: null, loyaltyTierFloorSetAt: null });
  });

  it("a manager seat can", async () => {
    const c = await client(shopId, 1);
    const res = await setTier(managerCookie, c.id, { tier: "SILVER" });
    expect(res.status).toBe(200);
    expect((await row(c.id))?.loyaltyTier).toBe("SILVER");
  });

  it("the body is exactly { tier } - a tier this ladder has, or null", async () => {
    const c = await client(shopId, 1);
    for (const body of [{}, { tier: "PLATINUM" }, { tier: "gold" }, { tier: "GOLD", clientId: c.id }]) {
      const res = await setTier(ownerCookie, c.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_input");
    }
    expect((await row(c.id))?.loyaltyTierFloor).toBeNull();
  });
});
