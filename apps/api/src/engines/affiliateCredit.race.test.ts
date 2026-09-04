import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  __resetEnvCacheForTests,
  randomToken,
} from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * EXACTLY ONE CREDIT, under contention. Three guards, each removed in turn:
 *
 *   - AffiliateCreditOperation.rewardId is UNIQUE: two operations for one
 *     reward cannot exist (asserted against the index itself)
 *   - RESERVE is a compare-and-set on AVAILABLE: two reservers racing one
 *     reward create one operation (a real interleaving, behind a row lock)
 *   - EXECUTE claims with FOR UPDATE SKIP LOCKED and the Stripe call carries
 *     the reward's own idempotency key: twenty workers, one credit
 */

const retrieve = vi.fn();
const createBalanceTransaction = vi.fn();
vi.mock("../billing/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/stripe.js")>();
  return {
    ...actual,
    stripeClient: () => ({
      subscriptions: { retrieve },
      customers: { createBalanceTransaction },
    }),
  };
});

const { executeAffiliateCredits, reserveAffiliateCredits } = await import("./affiliateCredit.js");

const NOW = new Date("2026-09-12T12:00:00Z");
const emails: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];
let adminId = "";

async function affiliate() {
  const email = `affrace-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: "Aff" }, select: { id: true } });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: `Aff ${randomToken(4)}`,
      slug: `affrace-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      stripeCustomerId: `cus_${randomToken(8)}`,
      stripeSubscriptionId: `sub_${randomToken(8)}`,
      subscriptionStatus: "active",
      plan: "pro",
    },
    select: { id: true, stripeCustomerId: true },
  });
  shopIds.push(shop.id);
  const referredEmail = `refrace-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(referredEmail);
  const referredOwner = await prisma.user.create({ data: { email: referredEmail, name: "Ref" }, select: { id: true } });
  const referred = await prisma.shop.create({
    data: { ownerId: referredOwner.id, name: `Ref ${randomToken(4)}`, slug: `refrace-${randomToken(5)}`.toLowerCase(), webhookSecret: randomToken(), bookingMode: "native" },
    select: { id: true },
  });
  shopIds.push(referred.id);
  const { accountId, rewardId } = await runAsOwner(async (tx) => {
    const app = await tx.affiliateApplication.create({
      data: {
        shopId: shop.id,
        submittedByUserId: user.id,
        status: "APPROVED",
        audienceDescription: "x",
        promotionPlan: "y",
        ftcAcknowledgedAt: NOW,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: NOW,
        decidedAt: NOW,
        decidedByUserId: adminId,
        decisionReason: "approved",
      },
      select: { id: true },
    });
    const account = await tx.affiliateAccount.create({
      data: { shopId: shop.id, applicationId: app.id, code: randomToken(9), acceptedTermsVersion: AFFILIATE_TERMS_VERSION, policyVersion: AFFILIATE_POLICY_VERSION },
      select: { id: true },
    });
    const attribution = await tx.affiliateReferralAttribution.create({
      data: { affiliateAccountId: account.id, referredShopId: referred.id, codeUsed: "x", source: "link", state: "ATTRIBUTED", capturedAt: NOW, lockedAt: NOW, claimExpiresAt: new Date(NOW.getTime() + 86_400_000) },
      select: { id: true },
    });
    const reward = await tx.affiliateReward.create({
      data: {
        affiliateAccountId: account.id,
        referredShopId: referred.id,
        attributionId: attribution.id,
        rewardType: "subscription_credit",
        amountCents: 3499,
        currency: "usd",
        basisPlan: "pro",
        status: "AVAILABLE",
        qualifiedAt: NOW,
        holdEndsAt: NOW,
        availableAt: NOW,
        expiresAt: new Date(NOW.getTime() + 365 * 86_400_000),
      },
      select: { id: true },
    });
    return { accountId: account.id, rewardId: reward.id };
  });
  accountIds.push(accountId);
  return { shopId: shop.id, customerId: shop.stripeCustomerId!, accountId, rewardId };
}

const operationsFor = (rewardId: string) =>
  runAsOwner((tx) => tx.affiliateCreditOperation.findMany({ where: { rewardId } }));
const rewardStatus = (id: string) =>
  runAsOwner((tx) => tx.affiliateReward.findUnique({ where: { id }, select: { status: true } })).then((r) => r?.status);

beforeAll(async () => {
  const email = `oprace-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  adminId = (await prisma.user.create({ data: { email, name: "Op", isAdmin: true }, select: { id: true } })).id;
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  process.env.AFFILIATE_CREDIT_EXECUTION_ENABLED = "true";
  __resetEnvCacheForTests();
});

beforeEach(() => {
  retrieve.mockReset();
  createBalanceTransaction.mockReset();
  retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 3499 } }] } });
  createBalanceTransaction.mockImplementation(async () => ({ id: `cbtxn_${randomToken(6)}` }));
});

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_CREDIT_EXECUTION_ENABLED;
  __resetEnvCacheForTests();
  await runAsOwner(async (tx) => {
    await tx.affiliateCreditOperation.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.affiliateReward.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateReferralAttribution.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
  });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("exactly one credit", () => {
  it("one operation per reward is a database constraint", async () => {
    const f = await affiliate();
    await runAsOwner((tx) =>
      tx.affiliateCreditOperation.create({
        data: { rewardId: f.rewardId, affiliateAccountId: f.accountId, shopId: f.shopId, amountCents: 3499, currency: "usd" },
      }),
    );
    await expect(
      runAsOwner((tx) =>
        tx.affiliateCreditOperation.create({
          data: { rewardId: f.rewardId, affiliateAccountId: f.accountId, shopId: f.shopId, amountCents: 3499, currency: "usd" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("two reservers racing one AVAILABLE reward create one operation - the compare-and-set", async () => {
    const f = await affiliate();
    const { results, settledEarly } = await raceBehindRowLock("AffiliateReward", f.rewardId, [
      () => reserveAffiliateCredits({ now: NOW }),
      () => reserveAffiliateCredits({ now: NOW }),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await operationsFor(f.rewardId)).toHaveLength(1);
    expect(await rewardStatus(f.rewardId)).toBe("RESERVED");
  });

  it("twenty simultaneous workers apply exactly one credit, under the reward's own idempotency key", async () => {
    const f = await affiliate();
    await reserveAffiliateCredits({ now: NOW });
    // The structural guard, head-on, before the workers run.
    await expect(
      runAsOwner((tx) =>
        tx.affiliateCreditOperation.create({
          data: { rewardId: f.rewardId, affiliateAccountId: f.accountId, shopId: f.shopId, amountCents: 1, currency: "usd" },
        }),
      ),
    ).rejects.toThrow();
    createBalanceTransaction.mockClear();
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => executeAffiliateCredits({ now: NOW })),
    );
    const mine = createBalanceTransaction.mock.calls.filter((c) => c[0] === f.customerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]![2]).toEqual({ idempotencyKey: `affiliate-reward:${f.rewardId}` });
    // The workers also drain whatever other operations this file left pending;
    // what must hold is that every "applied" a worker reports is exactly one
    // Stripe call, and this reward's is one of them.
    expect(runs.reduce((n, r) => n + r.applied, 0)).toBe(createBalanceTransaction.mock.calls.length);
    expect(runs.reduce((n, r) => n + r.applied, 0)).toBeGreaterThanOrEqual(1);
    const ops = await operationsFor(f.rewardId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe("APPLIED");
    expect(ops[0]!.appliedCents).toBe(3499);
    expect(await rewardStatus(f.rewardId)).toBe("APPLIED");
  });
});
