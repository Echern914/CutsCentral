import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Loyalty designer flow, end to end through the HTTP surface: shop creation
 * seeds the first reward, the barber builds a menu + earn rules, redeems a
 * specific reward, and one shop can never touch another's program.
 */
const app = createApp();
const emailA = `loy-a-${randomToken(6)}@test.local`;
const emailB = `loy-b-${randomToken(6)}@test.local`;
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let clientId: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Loyalty Tester" });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: shopName,
      bookingUrl: "https://loyalty.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
    });
  expect(shop.status).toBe(201);
  return cookie;
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Loyalty Cuts A");
  cookieB = await signupAndShop(emailB, "Loyalty Cuts B");

  // A walk-in client for shop A to redeem against.
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookieA)
    .send({ firstName: "Redeemer" });
  expect(created.status).toBe(201);
  clientId = created.body.id;
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

describe("loyalty designer", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/loyalty");
    expect(res.status).toBe(401);
  });

  it("shop creation seeded the first menu reward", async () => {
    const res = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(res.status).toBe(200);
    expect(res.body.punchesPerVisit).toBe(1);
    expect(res.body.rewards).toHaveLength(1);
    expect(res.body.rewards[0].name).toBe("Free Cut");
    expect(res.body.rewards[0].punchCost).toBe(10);
  });

  let beardRewardId: string;

  it("adds a second reward to the menu", async () => {
    const res = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieA)
      .send({ name: "Free Beard Trim", emoji: "🧔", punchCost: 5, description: "Lineup included" });
    expect(res.status).toBe(201);
    beardRewardId = res.body.id;

    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(config.body.rewards).toHaveLength(2);
  });

  it("rejects junk reward input", async () => {
    const res = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieA)
      .send({ name: "", punchCost: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("edits and reorders the menu", async () => {
    const patch = await request(app)
      .patch(`/api/loyalty/rewards/${beardRewardId}`)
      .set("Cookie", cookieA)
      .send({ punchCost: 4 });
    expect(patch.status).toBe(200);

    const before = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    const ids = before.body.rewards.map((r: { id: string }) => r.id) as string[];
    const reorder = await request(app)
      .post("/api/loyalty/rewards/reorder")
      .set("Cookie", cookieA)
      .send({ ids: [...ids].reverse() });
    expect(reorder.status).toBe(200);

    const after = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(after.body.rewards[0].id).toBe(beardRewardId);
    expect(after.body.rewards[0].punchCost).toBe(4);
  });

  it("configures the earn rate and service bonuses", async () => {
    const rate = await request(app)
      .patch("/api/loyalty/settings")
      .set("Cookie", cookieA)
      .send({ punchesPerVisit: 2 });
    expect(rate.status).toBe(200);

    const rule = await request(app)
      .post("/api/loyalty/rules")
      .set("Cookie", cookieA)
      .send({ serviceMatch: "Beard", punches: 3 });
    expect(rule.status).toBe(201);

    const config = await request(app).get("/api/loyalty").set("Cookie", cookieA);
    expect(config.body.punchesPerVisit).toBe(2);
    expect(config.body.rules).toHaveLength(1);
    expect(config.body.rules[0].serviceMatch).toBe("Beard");
  });

  it("cross-tenant: shop B cannot read or touch shop A's program", async () => {
    const configB = await request(app).get("/api/loyalty").set("Cookie", cookieB);
    // B sees only its own seeded reward, never A's menu.
    expect(configB.body.rewards).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/loyalty/rewards/${beardRewardId}`)
      .set("Cookie", cookieB)
      .send({ punchCost: 1 });
    expect(patch.status).toBe(404);

    const del = await request(app)
      .delete(`/api/loyalty/rewards/${beardRewardId}`)
      .set("Cookie", cookieB);
    expect(del.status).toBe(404);
  });

  it("redeems a specific reward once the balance covers it", async () => {
    // 3 bonus punches: covers the 4-cost beard trim only after one more.
    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 3 });

    const broke = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookieA)
      .send({ rewardId: beardRewardId });
    expect(broke.status).toBe(400);
    expect(broke.body.error).toBe("insufficient_punches");
    expect(broke.body.required).toBe(4);

    await request(app)
      .post(`/api/dashboard/clients/${clientId}/bonus`)
      .set("Cookie", cookieA)
      .send({ count: 1 });

    const ok = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookieA)
      .send({ rewardId: beardRewardId });
    expect(ok.status).toBe(200);
    expect(ok.body.newBalance).toBe(0);
    expect(ok.body.reward.name).toBe("Free Beard Trim");

    // The ledger row records WHICH reward was bought.
    const entry = await prisma.punchLedger.findFirst({
      where: { clientId, punchesRedeemed: { gt: 0 } },
    });
    expect(entry?.rewardId).toBe(beardRewardId);
    expect(entry?.note).toBe("Free Beard Trim");
  });

  it("rejects redemption against a foreign or unknown reward", async () => {
    const res = await request(app)
      .post(`/api/dashboard/redeem/${clientId}`)
      .set("Cookie", cookieA)
      .send({ rewardId: "does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("reward_not_found");
  });

  it("client detail reports the menu with affordability", async () => {
    const res = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.rewards.length).toBeGreaterThan(0);
    expect(res.body.rewards.every((r: { affordable: boolean }) => !r.affordable)).toBe(true);
    expect(res.body.rewardReady).toBe(false);
  });
});
