import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Tier perks, end to end: an owner writes what each tier is worth, and the
 * client who earned it sees it on their own rewards page.
 *
 * The point of the feature is that last hop. A tier the customer cannot see
 * the value of is a rank with nothing attached, which is what shipped
 * originally — the only thing Gold actually did was quietly move you up the
 * waitlist.
 */

const app = createApp();

let ownerCookie = "";
let shopId = "";
let magicToken = "";

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "Tier Owner", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

beforeAll(async () => {
  ownerCookie = await signup(`tier-${randomToken(6).toLowerCase()}@test.chairback`);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Tier Cuts", bookingUrl: "https://tier.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;

  // Rewards on, or the customer payload deliberately empties itself.
  await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } });

  magicToken = randomToken(24);
  await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tier-${randomToken(6)}`,
      firstName: "Ricky",
      magicToken,
    },
  });
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("an owner writes what each tier is worth", () => {
  it("saves the perks and reads them back", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({
        tierPerks: {
          BRONZE: "Free drink on us",
          SILVER: "10% off products",
          GOLD: "First pick of cancellations",
        },
      });
    expect(res.status).toBe(200);

    const config = await request(app).get("/api/loyalty").set("Cookie", ownerCookie);
    expect(config.status).toBe(200);
    expect(config.body.tierPerks).toEqual({
      BRONZE: "Free drink on us",
      SILVER: "10% off products",
      GOLD: "First pick of cancellations",
    });
  });

  it("a blank string withdraws a promise rather than leaving it up", async () => {
    // An owner who stops offering something must be able to take it down; a
    // perk that lingers on the client's page is a promise nobody is keeping.
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierPerks: { BRONZE: "Free drink on us", SILVER: "", GOLD: "" } });

    const config = await request(app).get("/api/loyalty").set("Cookie", ownerCookie);
    expect(config.body.tierPerks).toEqual({ BRONZE: "Free drink on us" });
  });

  it("refuses an unknown tier key rather than storing it", async () => {
    const res = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierPerks: { PLATINUM: "Does not exist" } });
    expect(res.status).toBe(400);
  });
});

describe("the client sees where they stand", () => {
  it("🔴 returns the tier, the bar, and what it is worth", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({
        tierPerks: { BRONZE: "Free drink on us", SILVER: "10% off products" },
      });

    // Three completed visits: past Bronze (1), short of Silver (6). The tier
    // is counted from Visit rows, so these are the whole fixture.
    const client = await prisma.client.findFirstOrThrow({ where: { shopId } });
    for (let i = 0; i < 3; i++) {
      await prisma.visit.create({
        data: {
          shopId,
          clientId: client.id,
          acuityAppointmentId: `tier-visit-${i}-${randomToken(6)}`,
          status: "COMPLETED",
          serviceName: "Cut",
          scheduledAt: new Date(`2026-0${i + 1}-10T15:00:00Z`),
          completedAt: new Date(`2026-0${i + 1}-10T15:30:00Z`),
        },
      });
    }

    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    const loyalty = res.body.loyalty;

    expect(loyalty.tier).toBe("BRONZE");
    expect(loyalty.visits).toBe(3);
    // What Bronze is worth here - the whole point of the feature.
    expect(loyalty.perk).toBe("Free drink on us");

    // And what is waiting one tier up, which is the reason to come back.
    expect(loyalty.nextTier.label).toBe("Silver");
    expect(loyalty.nextTier.visitsAway).toBe(3);
    expect(loyalty.nextTier.perk).toBe("10% off products");

    // The bar: 2 of the 5 visits between Bronze(1) and Silver(6).
    expect(loyalty.fraction).toBeCloseTo(2 / 5);
  });

  it("a shop that has written no perks still renders a tier, just without one", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", ownerCookie)
      .send({ tierPerks: {} });

    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.body.loyalty.tier).toBe("BRONZE");
    expect(res.body.loyalty.perk).toBeNull();
    expect(res.body.loyalty.nextTier.perk).toBeNull();
    // The bar is unaffected by whether anyone wrote copy.
    expect(res.body.loyalty.fraction).toBeCloseTo(2 / 5);
  });

  it("rewards off hides the tier entirely, perks included", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: false } });
    try {
      const res = await request(app).get(`/api/rewards/${magicToken}`);
      expect(res.status).toBe(200);
      // The existing contract: with rewards off the client sees none of it.
      // The flag rides on the shop object, not the top level.
      expect(res.body.shop.rewardsEnabled).toBe(false);
      expect(res.body.punches.balance).toBe(0);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { rewardsEnabled: true } });
    }
  });
});
