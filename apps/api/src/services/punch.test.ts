import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forShop, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { earnPunchForVisit, redeemReward } from "./punch.js";

/**
 * Earn-rule engine at the service level: base rate, service overrides,
 * idempotency, and reward-specific redemption.
 */
let userId: string;
let shopId: string;
let clientId: string;
let seq = 0;

async function makeVisit(serviceName: string | null): Promise<string> {
  const v = await forShop(shopId).visit.upsert({
    where: {
      shopId_acuityAppointmentId: { shopId, acuityAppointmentId: `pe-${++seq}` },
    },
    create: {
      clientId,
      acuityAppointmentId: `pe-${seq}`,
      status: "COMPLETED",
      scheduledAt: new Date("2026-05-01T15:00:00Z"),
      serviceName,
    },
    update: {},
  });
  return v.id;
}

async function balance(): Promise<number> {
  const agg = await prisma.punchLedger.aggregate({
    where: { shopId, clientId },
    _sum: { punchesEarned: true, punchesRedeemed: true },
  });
  return (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `pe-${randomToken(6)}@test.local`, passwordHash: "x", name: "PE" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Earn Rules Cuts",
      bookingUrl: "https://pe.test",
      punchesPerVisit: 2, // base rate: every visit earns 2
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  const client = await forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: "tel:+13025550042" } },
    create: { acuityClientKey: "tel:+13025550042", magicToken: randomToken() },
    update: {},
  });
  clientId = client.id;
  // Two rules; the first match by sortOrder must win.
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "Premium", punches: 5, sortOrder: 0 },
  });
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "beard", punches: 3, sortOrder: 1 },
  });
  await forShop(shopId).earnRule.create({
    data: { serviceMatch: "kids", punches: 1, active: false, sortOrder: 2 },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const earnShop = () => ({ id: shopId, punchesPerVisit: 2 });

describe("earn rules", () => {
  it("earns the shop's base rate when no rule matches", async () => {
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(2);
  });

  it("a matching service rule overrides the base rate (case-insensitive)", async () => {
    const visitId = await makeVisit("Cut + Beard Trim");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Cut + Beard Trim");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(3);
  });

  it("first matching rule by sortOrder wins", async () => {
    const visitId = await makeVisit("Premium Cut + Beard");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Premium Cut + Beard");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(5);
  });

  it("inactive rules never fire", async () => {
    const visitId = await makeVisit("Kids Cut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Kids Cut");
    const entry = await prisma.punchLedger.findUnique({ where: { visitId } });
    expect(entry?.punchesEarned).toBe(2); // base, not the paused 1
  });

  it("earning is idempotent per visit", async () => {
    const before = await balance();
    const visitId = await makeVisit("Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    await earnPunchForVisit(earnShop(), clientId, visitId, "Standard Haircut");
    const entries = await prisma.punchLedger.findMany({ where: { visitId } });
    expect(entries).toHaveLength(1);
    expect(await balance()).toBe(before + 2);
  });
});

describe("redeemReward", () => {
  it("redeems a specific reward and records it in the ledger", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Free Lineup", punchCost: 3 },
    });
    const before = await balance();
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newBalance).toBe(before - 3);
      expect(result.reward.name).toBe("Free Lineup");
    }
  });

  it("refuses when the balance is short", async () => {
    const reward = await forShop(shopId).reward.create({
      data: { name: "Grail Package", punchCost: 100 },
    });
    const result = await redeemReward(shopId, clientId, reward.id);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "insufficient_punches") {
      expect(result.required).toBe(100);
    } else {
      expect.fail("expected insufficient_punches");
    }
  });

  it("refuses a reward that is not on this shop's menu", async () => {
    const result = await redeemReward(shopId, clientId, "not-a-reward");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reward_not_found");
  });
});
