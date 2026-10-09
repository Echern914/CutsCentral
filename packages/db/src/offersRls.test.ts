import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * Offer and OfferRedemption are TENANT tables (migration 20261053000000_offers).
 * A shop session sees its own offers and none of another shop's - a code is
 * looked up by (shop, code) and must never resolve across shops.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */
let userId: string;
let shopA: string;
let shopB: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `offerrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "OFR" },
  });
  userId = user.id;
  shopA = (await prisma.shop.create({ data: { ownerId: userId, name: "OFR A", bookingUrl: "https://a.test", webhookSecret: randomToken() } })).id;
  shopB = (await prisma.shop.create({ data: { ownerId: userId, name: "OFR B", bookingUrl: "https://b.test", webhookSecret: randomToken() } })).id;
  await prisma.offer.create({ data: { shopId: shopA, code: "SAMECODE", kind: "AMOUNT_OFF", amountOffCents: 500 } });
  await prisma.offer.create({ data: { shopId: shopB, code: "SAMECODE", kind: "PERCENT_OFF", percentOffBps: 5000 } });
  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  if (shopA && shopB) await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("Offer and OfferRedemption in the catalog", () => {
  it.each(["Offer", "OfferRedemption"])("%s has RLS enabled AND forced, with the tenant_isolation policy", async (table) => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '${table}' AND relkind = 'r'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = '${table}'`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });
});

describe("🔴 a shop session sees only its own offers", () => {
  it("the same code in two shops: each shop finds only its own", async () => {
    if (!rlsActive) return;
    const seen = await runWithShop(shopA, (tx) => tx.offer.findMany({ where: { code: "SAMECODE" }, select: { shopId: true, kind: true } }));
    expect(seen).toEqual([{ shopId: shopA, kind: "AMOUNT_OFF" }]);
  });

  it("a shop session cannot write an offer into another shop", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) => tx.offer.create({ data: { shopId: shopB, code: "SNEAKY", kind: "AMOUNT_OFF", amountOffCents: 100 } })),
    ).rejects.toThrow();
  });

  it("the value check refuses an offer with no value, or two", async () => {
    await expect(prisma.offer.create({ data: { shopId: shopA, code: "NOVALUE", kind: "AMOUNT_OFF" } })).rejects.toThrow();
    await expect(
      prisma.offer.create({ data: { shopId: shopA, code: "TWOVALUES", kind: "AMOUNT_OFF", amountOffCents: 100, percentOffBps: 100 } }),
    ).rejects.toThrow();
    await expect(prisma.offer.create({ data: { shopId: shopA, code: "lower", kind: "AMOUNT_OFF", amountOffCents: 100 } })).rejects.toThrow();
  });
});
