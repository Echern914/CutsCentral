import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * PaymentRefund - who gave a customer their money back, and why.
 *
 * Proven against the LIVE catalog and a live tenant session, not by reading
 * the migration, because a refund record is the audit behind the most
 * sensitive manual money action in the product:
 *
 *  1. It is a TENANT table: RLS enabled AND forced, tenant_isolation present.
 *  2. A shop session cannot see another shop's refunds.
 *  3. It is append-only for everyone, the connection owner included.
 *  4. A refund is a positive number of cents with one of four outcomes.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let shopA: string;
let shopB: string;
let refundB: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `refundrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "RefundRLS" },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "Refund A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "Refund B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  shopB = b.id;
  // Seeded through the owner connection, which bypasses the policy - so shop B
  // genuinely has a refund for shop A to fail to see.
  const row = await prisma.paymentRefund.create({
    data: {
      shopId: shopB,
      paymentId: `pay_${randomToken(8)}`,
      appointmentId: `appt_${randomToken(8)}`,
      actorUserId: userId,
      amountCents: 100,
      reverseTransfer: false,
      stripeRefundId: `re_${randomToken(8)}`,
      outcome: "succeeded",
      note: "B only",
    },
  });
  refundB = row.id;
  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("PaymentRefund in the catalog", () => {
  it("has RLS enabled AND forced", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'PaymentRefund' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    // FORCE matters: without it the owner - how the app connects - bypasses the
    // policy and the isolation is decorative.
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });

  it("carries the tenant_isolation policy", async () => {
    const rows = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'PaymentRefund'`,
    );
    expect(rows.map((r) => r.policyname)).toContain("tenant_isolation");
  });
});

describe("a shop-A session and shop B's refunds", () => {
  it("cannot read them, even without an app-level shop filter", async () => {
    if (!rlsActive) return;
    await runWithShop(shopA, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "PaymentRefund"`);
      expect(rows.map((r) => r.id)).not.toContain(refundB);
    });
  });

  it("cannot write a refund stamped with another shop's id", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.paymentRefund.create({
          data: {
            shopId: shopB,
            paymentId: "pay_x",
            appointmentId: "appt_x",
            amountCents: 1,
            reverseTransfer: true,
            outcome: "succeeded",
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("the record cannot be rewritten", () => {
  it("🔴 refuses UPDATE, even for the connection owner", async () => {
    await expect(
      prisma.paymentRefund.update({ where: { id: refundB }, data: { amountCents: 1 } }),
    ).rejects.toThrow(/append-only/);
    const row = await prisma.paymentRefund.findUnique({ where: { id: refundB } });
    expect(row!.amountCents).toBe(100);
  });

  it("a refund of zero cents is not a refund", async () => {
    await expect(
      prisma.paymentRefund.create({
        data: { shopId: shopB, paymentId: "p", appointmentId: "a", amountCents: 0, reverseTransfer: true, outcome: "succeeded" },
      }),
    ).rejects.toThrow();
  });

  it("the outcome is one of four words", async () => {
    await expect(
      prisma.paymentRefund.create({
        data: { shopId: shopB, paymentId: "p", appointmentId: "a", amountCents: 1, reverseTransfer: true, outcome: "done" },
      }),
    ).rejects.toThrow();
  });
});
