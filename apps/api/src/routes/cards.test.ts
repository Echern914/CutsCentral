import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Punch card types through the HTTP surface: card CRUD + caps + reorder,
 * exclusive-card grants, delete-vs-archive (409 has_activity), reward-to-card
 * scoping, cross-shop isolation, and the PUBLIC rewards payload's cards array
 * (including the zero-card back-compat shape).
 */
const app = createApp();
const emailA = `card-a-${randomToken(6)}@test.local`;
const emailB = `card-b-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let clientId: string;
let magicToken: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Card Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: shopName,
      bookingUrl: "https://cards.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shop.status).toBe(201);
  // Rewards are opt-IN for new shops (default off); this suite exercises loyalty.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ rewardsEnabled: true });
  return cookie;
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Card Cuts A");
  cookieB = await signupAndShop(emailB, "Card Cuts B");
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookieA)
    .send({ firstName: "Carder" });
  expect(created.status).toBe(201);
  clientId = created.body.id;
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  magicToken = client!.magicToken;
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("zero-card back-compat", () => {
  it("the public payload has exactly one (default) card and unchanged top-level fields", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.punches.balance).toBe(0);
    expect(res.body.rewards).toHaveLength(1); // the seeded Free Cut
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].id).toBeNull();
    expect(res.body.cards[0].name).toBe("Punch Card");
    expect(res.body.cards[0].balance).toBe(0);
    expect(res.body.cards[0].rewards).toHaveLength(1);
  });
});

describe("card type CRUD", () => {
  let retwistId: string;
  let vipId: string;

  it("creates cards and returns them in the loyalty config", async () => {
    const retwist = await request(app)
      .post("/api/loyalty/cards")
      .set("Cookie", cookieA)
      .send({ name: "Retwist", serviceMatch: ["retwist"], punchesPerVisit: 2 });
    expect(retwist.status).toBe(201);
    retwistId = retwist.body.id;

    const vip = await request(app)
      .post("/api/loyalty/cards")
      .set("Cookie", cookieA)
      .send({ name: "VIP", exclusive: true, accentColor: "#D4AF37" });
    expect(vip.status).toBe(201);
    vipId = vip.body.id;

    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(config.status).toBe(200);
    expect(config.body.cards).toHaveLength(2);
    const names = config.body.cards.map((c: { name: string }) => c.name);
    expect(names).toContain("Retwist");
    expect(names).toContain("VIP");
    const vipRow = config.body.cards.find((c: { id: string }) => c.id === vipId);
    expect(vipRow.exclusive).toBe(true);
    expect(vipRow.grantCount).toBe(0);
    expect(vipRow.hasActivity).toBe(false);
  });

  it("rejects a bad accent color", async () => {
    const res = await request(app)
      .post("/api/loyalty/cards")
      .set("Cookie", cookieA)
      .send({ name: "Bad Color", accentColor: "gold" });
    expect(res.status).toBe(400);
  });

  it("edits a card", async () => {
    const res = await request(app)
      .patch(`/api/loyalty/cards/${retwistId}`)
      .set("Cookie", cookieA)
      .send({ serviceMatch: ["retwist", "twist"], emoji: "🌀" });
    expect(res.status).toBe(200);
    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    const row = config.body.cards.find((c: { id: string }) => c.id === retwistId);
    expect(row.serviceMatch).toEqual(["retwist", "twist"]);
  });

  it("another shop cannot touch my cards", async () => {
    const patch = await request(app)
      .patch(`/api/loyalty/cards/${retwistId}`)
      .set("Cookie", cookieB)
      .send({ name: "Hijacked" });
    expect(patch.status).toBe(404);
    const del = await request(app)
      .delete(`/api/loyalty/cards/${retwistId}`)
      .set("Cookie", cookieB);
    expect(del.status).toBe(404);
  });

  it("scopes a reward to a card, and rejects a foreign card id", async () => {
    const ok = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieA)
      .send({ name: "Free Retwist", punchCost: 5, cardTypeId: retwistId });
    expect(ok.status).toBe(201);

    // Shop B tries to point a reward at shop A's card.
    const bad = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieB)
      .send({ name: "Sneaky", punchCost: 5, cardTypeId: retwistId });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_card");
  });

  it("grants + revokes exclusive-card membership", async () => {
    const grant = await request(app)
      .post(`/api/loyalty/cards/${vipId}/grants`)
      .set("Cookie", cookieA)
      .send({ clientId });
    expect(grant.status).toBe(201);
    // Idempotent: granting again succeeds without a duplicate.
    const again = await request(app)
      .post(`/api/loyalty/cards/${vipId}/grants`)
      .set("Cookie", cookieA)
      .send({ clientId });
    expect(again.status).toBe(201);

    const list = await request(app)
      .get(`/api/loyalty/cards/${vipId}/grants`)
      .set("Cookie", cookieA);
    expect(list.status).toBe(200);
    expect(list.body.grants).toHaveLength(1);
    expect(list.body.grants[0].clientId).toBe(clientId);

    const revoke = await request(app)
      .delete(`/api/loyalty/cards/${vipId}/grants/${clientId}`)
      .set("Cookie", cookieA);
    expect(revoke.status).toBe(200);
    const after = await request(app)
      .get(`/api/loyalty/cards/${vipId}/grants`)
      .set("Cookie", cookieA);
    expect(after.body.grants).toHaveLength(0);
  });

  it("logging a visit with a card override punches that card", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ serviceName: "Hot Towel Shave", cardTypeId: retwistId });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(2); // the Retwist card's rate + its balance

    const ledger = await request(app)
      .get(`/api/dashboard/clients/${clientId}/ledger`)
      .set("Cookie", cookieA);
    expect(ledger.status).toBe(200);
    const cardRow = ledger.body.cards.find((c: { id: string | null }) => c.id === retwistId);
    expect(cardRow.balance).toBe(2);
    const entry = ledger.body.entries[0];
    expect(entry.card?.id).toBe(retwistId);
    // A bad card id 404s instead of silently punching the default card.
    const bad = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ cardTypeId: "not-a-card" });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toBe("card_not_found");
  });

  it("auto-routes a matching service without an override", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ serviceName: "Loc Retwist" });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(4); // 2 + 2 on the Retwist card
  });

  it("the public payload shows per-card balances; exclusive stays hidden until granted", async () => {
    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    // Default card + Retwist (public). VIP is exclusive + ungranted + no
    // activity -> hidden.
    const ids = res.body.cards.map((c: { id: string | null }) => c.id);
    expect(ids).toContain(null);
    expect(ids).toContain(retwistId);
    expect(ids).not.toContain(vipId);
    const retwistCard = res.body.cards.find((c: { id: string | null }) => c.id === retwistId);
    expect(retwistCard.balance).toBe(4);
    expect(retwistCard.nextTarget.name).toBe("Free Retwist"); // card-scoped target
    expect(retwistCard.nextTarget.remaining).toBe(1); // 5 - 4
    // Top-level view is still the DEFAULT card's (balance 0 here).
    expect(res.body.punches.balance).toBe(0);

    // Grant VIP -> it appears.
    await request(app)
      .post(`/api/loyalty/cards/${vipId}/grants`)
      .set("Cookie", cookieA)
      .send({ clientId });
    const after = await request(app).get(`/api/rewards/${magicToken}`);
    const afterIds = after.body.cards.map((c: { id: string | null }) => c.id);
    expect(afterIds).toContain(vipId);
  });

  it("refuses to delete a card with ledger history (archive instead), allows clean deletes", async () => {
    const used = await request(app)
      .delete(`/api/loyalty/cards/${retwistId}`)
      .set("Cookie", cookieA);
    expect(used.status).toBe(409);
    expect(used.body.error).toBe("has_activity");

    // Archiving is the supported path for a used card.
    const archive = await request(app)
      .patch(`/api/loyalty/cards/${retwistId}`)
      .set("Cookie", cookieA)
      .send({ active: false });
    expect(archive.status).toBe(200);

    // A never-used card deletes cleanly (its grants cascade).
    const fresh = await request(app)
      .post("/api/loyalty/cards")
      .set("Cookie", cookieA)
      .send({ name: "Never Used" });
    const del = await request(app)
      .delete(`/api/loyalty/cards/${fresh.body.id}`)
      .set("Cookie", cookieA);
    expect(del.status).toBe(200);
  });

  it("enforces the card cap", async () => {
    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    const existing = config.body.cards.length;
    for (let i = existing; i < 8; i++) {
      const res = await request(app)
        .post("/api/loyalty/cards")
        .set("Cookie", cookieA)
        .send({ name: `Filler ${i}` });
      expect(res.status).toBe(201);
    }
    const overflow = await request(app)
      .post("/api/loyalty/cards")
      .set("Cookie", cookieA)
      .send({ name: "One Too Many" });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error).toBe("limit_reached");
  });

  it("reorders cards", async () => {
    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    const ids = config.body.cards.map((c: { id: string }) => c.id);
    const reversed = [...ids].reverse();
    const res = await request(app)
      .post("/api/loyalty/cards/reorder")
      .set("Cookie", cookieA)
      .send({ ids: reversed });
    expect(res.status).toBe(200);
    const after = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(after.body.cards.map((c: { id: string }) => c.id)).toEqual(reversed);
  });
});
