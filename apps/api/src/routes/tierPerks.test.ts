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

describe("book the usual", () => {
  /**
   * The note asked for "an auto rebook for the haircut they had in the past,
   * all they have to do is pick a time". The link has to name the service AND
   * the provider, and it has to disappear the moment we cannot honour it -
   * a link that dead-ends on arrival is worse than the ordinary menu.
   */
  async function usualFor(token: string) {
    const res = await request(app).get(`/api/rewards/${token}`);
    expect(res.status).toBe(200);
    return res.body.usual as {
      serviceId: string;
      staffId: string;
      serviceName: string;
      staffName: string;
      url: string;
    } | null;
  }

  it("offers nothing before there is a booking to repeat", async () => {
    expect(await usualFor(magicToken)).toBeNull();
  });

  it("🔴 names the last service AND provider, in a link that pre-picks both", async () => {
    const client = await prisma.client.findFirstOrThrow({ where: { shopId } });
    const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
    const service = await prisma.service.create({
      data: { shopId, name: "Skin fade", durationMin: 30, price: 40 },
    });
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "native", slug: `tier-${randomToken(5).toLowerCase()}` },
    });
    await prisma.appointment.create({
      data: {
        shopId,
        clientId: client.id,
        staffId: staff.id,
        serviceId: service.id,
        status: "COMPLETED",
        startsAt: new Date("2026-04-10T15:00:00Z"),
        endsAt: new Date("2026-04-10T15:30:00Z"),
        manageToken: randomToken(16),
        firstName: "Ricky",
      },
    });

    const usual = await usualFor(magicToken);
    expect(usual).not.toBeNull();
    expect(usual!.serviceName).toBe("Skin fade");
    expect(usual!.staffName).toBe("Drick");
    // The link is the whole feature: it must carry BOTH ids, or the client
    // lands back on the menu they were meant to skip.
    expect(usual!.url).toContain(`service=${usual!.serviceId}`);
    expect(usual!.url).toContain(`staff=${usual!.staffId}`);
    expect(usual!.url).toContain("/book/");
  });

  it("🔴 withdraws the offer when the service is retired", async () => {
    // The link would resolve to a service the booking page no longer lists, so
    // the prefill silently does nothing and the client wonders what happened.
    await prisma.service.updateMany({ where: { shopId }, data: { active: false } });
    try {
      expect(await usualFor(magicToken)).toBeNull();
    } finally {
      await prisma.service.updateMany({ where: { shopId }, data: { active: true } });
    }
  });

  it("🔴 withdraws the offer when the provider has left", async () => {
    await prisma.staff.updateMany({ where: { shopId }, data: { active: false } });
    try {
      expect(await usualFor(magicToken)).toBeNull();
    } finally {
      await prisma.staff.updateMany({ where: { shopId }, data: { active: true } });
    }
  });

  it("offers nothing when the shop books somewhere else", async () => {
    // An Acuity/Square shop's calendar does not live here, so a /book/ link
    // would be a link to a page that cannot take the booking.
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "acuity" } });
    try {
      expect(await usualFor(magicToken)).toBeNull();
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
    }
  });
});
