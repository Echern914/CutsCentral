import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * The partner program's tables hold platform money, so no tenant session may
 * read or write them: default-deny (RLS enabled AND forced, no policy, tenant
 * role revoked), plus the CHECKs that keep a reward and a cashout whole.
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

const TABLES = ["Partner", "PartnerReferral", "PartnerCashout"];
let userId: string;
let shopId: string;
let partnerId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `partnerrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "PartnerRLS" },
  });
  userId = user.id;
  shopId = (
    await prisma.shop.create({
      data: { ownerId: userId, name: "Partner RLS", bookingUrl: "https://t.test", webhookSecret: randomToken() },
    })
  ).id;
  partnerId = (
    await runAsOwner((tx) =>
      tx.partner.create({
        data: { name: "RLS", code: `R ${randomToken(4)}`, codeKey: `R${randomToken(8)}`.toUpperCase(), createdByUserId: userId },
      }),
    )
  ).id;
  try {
    await runWithShop(shopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await runAsOwner(async (tx) => {
    await tx.partnerCashout.deleteMany({ where: { partnerId } });
    await tx.partnerReferral.deleteMany({ where: { partnerId } });
    await tx.partner.delete({ where: { id: partnerId } });
  });
  await prisma.shop.delete({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("partner tables in the catalog", () => {
  it("have RLS enabled AND forced, with no policy at all", async () => {
    for (const table of TABLES) {
      const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
        table,
      );
      expect(rows, table).toHaveLength(1);
      expect(rows[0]!.relrowsecurity, table).toBe(true);
      expect(rows[0]!.relforcerowsecurity, table).toBe(true);
      const policies = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT policyname FROM pg_policies WHERE tablename = $1`,
        table,
      );
      expect(policies, table).toEqual([]);
    }
  });

  it("a reward is all-or-nothing, and only a credited one can be reversed", async () => {
    await expect(
      runAsOwner((tx) =>
        tx.partnerReferral.create({
          data: { partnerId, referredShopId: `half-${randomToken(6)}`, codeUsed: "X", creditedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/PartnerReferral_credit_check/);
    await expect(
      runAsOwner((tx) =>
        tx.partnerReferral.create({
          data: {
            partnerId,
            referredShopId: `rev-${randomToken(6)}`,
            codeUsed: "X",
            reversedAt: new Date(),
            reversalReason: "invoice_refunded",
          },
        }),
      ),
    ).rejects.toThrow(/PartnerReferral_reversal_check/);
  });

  it("a cashout is PAID exactly when someone paid it", async () => {
    await expect(
      runAsOwner((tx) =>
        tx.partnerCashout.create({
          data: { partnerId, amountCents: 2500, status: "PAID", requestedByUserId: userId },
        }),
      ),
    ).rejects.toThrow(/PartnerCashout_status_check/);
  });
});

describe("a shop session", () => {
  it("🔴 cannot read or write any partner table", async () => {
    if (!rlsActive) return;
    for (const table of TABLES) {
      await expect(
        runWithShop(shopId, (tx) => tx.$queryRawUnsafe(`SELECT "id" FROM "${table}"`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      runWithShop(shopId, (tx) => tx.$executeRawUnsafe(`UPDATE "Partner" SET "deactivatedAt" = now()`)),
    ).rejects.toThrow(/permission denied/);
  });
});
