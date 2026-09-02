import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { recomputeLoyaltyTiers } from "./loyaltyTierRecompute.js";

/**
 * 🔴 CHANGING WHAT A TIER TAKES MUST RE-STAMP EVERY CLIENT.
 *
 * Client.loyaltyTier is a stored column (cadence.ts writes it per completed
 * visit so the clients list can filter without counting). It is therefore a
 * claim about the thresholds in force WHEN IT WAS WRITTEN - and a shop that
 * raises Gold to 30 would otherwise leave a 12-visit client wearing Gold on
 * their own rewards page, with nothing erroring anywhere.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let shopId = "";
let cookie = "";
/** clientId -> lifetime completed visits */
const seeded = new Map<string, number>();

async function clientWithVisits(name: string, completed: number, extraCanceled = 0) {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: name,
      source: "manual",
    },
    select: { id: true },
  });
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < completed; i++) {
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: new Date(base + i * 7 * 86_400_000),
        status: "COMPLETED",
      },
    });
  }
  // Cancelled visits must never count toward a tier.
  for (let i = 0; i < extraCanceled; i++) {
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: new Date(base + (100 + i) * 86_400_000),
        status: "CANCELED",
      },
    });
  }
  seeded.set(client.id, completed);
  return client.id;
}

const tierOf = (id: string) =>
  prisma.client.findUnique({ where: { id }, select: { loyaltyTier: true } }).then((c) => c?.loyaltyTier ?? null);

let none = "", bronze = "", silver = "", gold = "";

beforeAll(async () => {
  const email = `tiers-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Tiers", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Tier Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;

  none = await clientWithVisits("Zero", 0);
  bronze = await clientWithVisits("One", 1, 3);
  silver = await clientWithVisits("Seven", 7);
  gold = await clientWithVisits("Twelve", 12);
  // Stamp them under the DEFAULT thresholds, as cadence.ts would have.
  await recomputeLoyaltyTiers(shopId, { BRONZE: 1, SILVER: 6, GOLD: 12 });
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("the starting point", () => {
  it("stamps each client from their COMPLETED visits only", async () => {
    expect(await tierOf(none)).toBeNull();
    expect(await tierOf(bronze)).toBe("BRONZE"); // 1 completed + 3 cancelled
    expect(await tierOf(silver)).toBe("SILVER");
    expect(await tierOf(gold)).toBe("GOLD");
  });
});

describe("PATCH /api/shops/me { tierThresholds }", () => {
  it("🔴 raising the bar re-stamps every client in the same request", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ tierThresholds: { BRONZE: 2, SILVER: 10, GOLD: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.tierThresholds).toEqual({ BRONZE: 2, SILVER: 10, GOLD: 30 });
    expect(res.body.tierRecompute.clients).toBe(4);
    expect(res.body.tierRecompute.changed).toBe(3);

    expect(await tierOf(none)).toBeNull();
    // 1 visit no longer earns anything - the badge is REMOVED, not kept.
    expect(await tierOf(bronze)).toBeNull();
    expect(await tierOf(silver)).toBe("BRONZE");
    expect(await tierOf(gold)).toBe("SILVER");
  });

  it("lowering it again promotes them back", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ tierThresholds: { BRONZE: 1, SILVER: 5, GOLD: 7 } });
    expect(res.status).toBe(200);
    expect(await tierOf(bronze)).toBe("BRONZE");
    expect(await tierOf(silver)).toBe("GOLD");
    expect(await tierOf(gold)).toBe("GOLD");
  });

  it("refuses a set that does not increase, and changes NOTHING", async () => {
    const before = await Promise.all([tierOf(bronze), tierOf(silver), tierOf(gold)]);
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ tierThresholds: { BRONZE: 9, SILVER: 3, GOLD: 20 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_tier_thresholds");
    expect(res.body.reason).toBe("not_increasing");
    expect(res.body.tier).toBe("SILVER");
    expect(await Promise.all([tierOf(bronze), tierOf(silver), tierOf(gold)])).toEqual(before);
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { tierThresholds: true },
    });
    expect(shop?.tierThresholds).toEqual({ BRONZE: 1, SILVER: 5, GOLD: 7 });
  });

  it("refuses zero and fractional visits", async () => {
    for (const bad of [
      { BRONZE: 0, SILVER: 5, GOLD: 7 },
      { BRONZE: 1, SILVER: 5.5, GOLD: 7 },
    ]) {
      const res = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ tierThresholds: bad });
      expect(res.status).toBe(400);
    }
  });

  it("a shop that never set any reads as the platform defaults", async () => {
    const other = await request(app)
      .post("/api/auth/signup")
      .send({ email: `tiers2-${randomToken(6)}@test.local`.toLowerCase(), password, name: "T2", smsAttested: true });
    emails.push(JSON.parse(JSON.stringify(other.body)).email ?? "");
    const c2 = (other.headers["set-cookie"] as unknown as string[])[0]!;
    const shop2 = await request(app)
      .post("/api/shops")
      .set("Cookie", c2)
      .send({ name: "Default Cuts", smsAttested: true });
    const res = await request(app).get("/api/shops/me").set("Cookie", c2);
    expect(res.status).toBe(200);
    expect(res.body.tierThresholds).toEqual({ BRONZE: 1, SILVER: 6, GOLD: 12 });
    await prisma.shop.deleteMany({ where: { id: shop2.body.id as string } });
  });
});

describe("a new completed visit keeps using the shop's numbers", () => {
  it("cadence stamps against the shop's thresholds, not the defaults", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ tierThresholds: { BRONZE: 4, SILVER: 8, GOLD: 20 } });
    expect(await tierOf(silver)).toBe("BRONZE"); // 7 visits, Bronze at 4

    const { recomputeCadence } = await import("./cadence.js");
    await prisma.visit.create({
      data: {
        shopId,
        clientId: silver,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: new Date(Date.UTC(2026, 6, 1)),
        status: "COMPLETED",
      },
    });
    await recomputeCadence(shopId, silver);
    // 8 completed visits: SILVER here, GOLD if it had used the defaults.
    expect(await tierOf(silver)).toBe("SILVER");
  });
});
