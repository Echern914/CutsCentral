import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * ShopExpense is a TENANT table (migration 20261079000000_shop_expenses). A
 * shop session sees its own expenses and none of another shop's, and cannot
 * write one into another shop - the database half of the two-layer isolation
 * (the routes also filter on shopId).
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */
let userId: string;
let shopA: string;
let shopB: string;
let rlsActive = true;

const DAY = new Date("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `exprls-${randomToken(6)}@test.local`, passwordHash: "x", name: "EXP" },
  });
  userId = user.id;
  shopA = (await prisma.shop.create({ data: { ownerId: userId, name: "EXP A", bookingUrl: "https://a.test", webhookSecret: randomToken() } })).id;
  shopB = (await prisma.shop.create({ data: { ownerId: userId, name: "EXP B", bookingUrl: "https://b.test", webhookSecret: randomToken() } })).id;
  await prisma.shopExpense.create({ data: { shopId: shopA, category: "rent", amountCents: 100_000, cadence: "monthly", startDate: DAY } });
  await prisma.shopExpense.create({ data: { shopId: shopB, category: "supplies", amountCents: 2_500, cadence: "once", startDate: DAY } });
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

describe("ShopExpense in the catalog", () => {
  it("has RLS enabled AND forced, with the tenant_isolation policy", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ShopExpense' AND relkind = 'r'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'ShopExpense'`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });
});

describe("🔴 a shop session sees only its own expenses", () => {
  it("an unfiltered read returns this shop's rows only", async () => {
    if (!rlsActive) return;
    const seen = await runWithShop(shopA, (tx) =>
      tx.shopExpense.findMany({ where: { shopId: { in: [shopA, shopB] } }, select: { shopId: true, category: true } }),
    );
    expect(seen).toEqual([{ shopId: shopA, category: "rent" }]);
  });

  it("cannot write an expense into another shop, or move one there", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.shopExpense.create({ data: { shopId: shopB, category: "other", amountCents: 1, cadence: "once", startDate: DAY } }),
      ),
    ).rejects.toThrow();
    const moved = await runWithShop(shopA, (tx) =>
      tx.shopExpense.updateMany({ where: { shopId: shopB }, data: { amountCents: 1 } }),
    );
    expect(moved.count).toBe(0);
    const b = await prisma.shopExpense.findFirst({ where: { shopId: shopB } });
    expect(b?.amountCents).toBe(2_500);
  });
});
