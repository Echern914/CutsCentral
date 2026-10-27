import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * The commission ledger's database-layer contract (migration
 * 20261077000000_affiliate_commissions), proven against the live catalog
 * rather than read off the migration:
 *
 *  1. Default-deny: RLS enabled + FORCED, zero policies, zero app-role grants.
 *  2. A tenant session cannot read it - a line names two shops and money.
 *  3. The CHECKs refuse impossible rows: an unknown kind or status, a zero
 *     amount, a rate above 100%, a REVERSED line with no reason, an
 *     AVAILABLE line never released, an unknown payout preference.
 *
 * Skips the tenant probe cleanly where the RLS role is not grantable.
 */

const TABLE = "AffiliateCommission";

let userId: string;
let shopId: string;
let rlsActive = true;

function line(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: `com${randomToken(8)}`,
    affiliateAccountId: `acct${randomToken(6)}`,
    referredShopId: shopId,
    stripeInvoiceId: `in_${randomToken(10)}`,
    baseAmountCents: 3499,
    rateBps: 3000,
    amountCents: 1049,
    currency: "usd",
    kind: "credit",
    earnedAt: now,
    holdEndsAt: new Date(now.getTime() + 30 * 86_400_000),
    updatedAt: now,
    ...over,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `comrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "ComRLS" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Com A",
      bookingUrl: "https://com-a.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  try {
    await runWithShop(shopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.affiliateCommission.deleteMany({ where: { referredShopId: shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("commission ledger: default-deny catalog state", () => {
  it("RLS is enabled AND forced, with zero policies and zero app-role grants", async () => {
    const flags = await prisma.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = $1 AND relkind = 'r'`,
      TABLE,
    );
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_policies WHERE tablename = $1`,
      TABLE,
    );
    expect(policies).toEqual([]);

    const grants = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM information_schema.table_privileges
        WHERE grantee = 'chairback_app' AND table_name = $1`,
      TABLE,
    );
    expect(grants).toEqual([]);
  });

  it("a tenant session cannot read it, even for its own referred shop", async () => {
    if (!rlsActive) return;
    await prisma.affiliateCommission.create({ data: line() });
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateCommission.findMany({})),
    ).rejects.toThrow();
  });
});

describe("commission ledger: CHECKs refuse impossible rows", () => {
  it.each([
    ["an unknown kind", { kind: "bitcoin" }],
    ["an unknown status", { status: "PENDING" }],
    ["a zero amount", { amountCents: 0 }],
    ["a zero base", { baseAmountCents: 0 }],
    ["a rate above 100%", { rateBps: 10_001 }],
    ["a zero rate", { rateBps: 0 }],
    ["an off-vocabulary reversal reason", { reversalReason: "felt_like_it" }],
    ["a REVERSED line without a reason", { status: "REVERSED", reversedAt: new Date() }],
    ["an AVAILABLE line never released", { status: "AVAILABLE" }],
    ["a PAID line never released", { status: "PAID" }],
  ])("refuses %s", async (_label, over) => {
    await expect(prisma.affiliateCommission.create({ data: line(over) })).rejects.toThrow();
  });

  it("accepts a well-formed line and a rate that changed without a migration", async () => {
    await expect(
      prisma.affiliateCommission.create({ data: line({ rateBps: 2500, amountCents: 874 }) }),
    ).resolves.toBeTruthy();
  });

  it("AffiliateAccount.payoutPreference is pinned to credit | cash", async () => {
    const rows = await prisma.$queryRawUnsafe<{ def: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'AffiliateAccount_payoutPreference_check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toContain("'credit'");
    expect(rows[0]!.def).toContain("'cash'");
  });
});
