import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";

/**
 * Credit execution against a scripted Stripe: one reservation per AVAILABLE
 * reward, one balance transaction per reward carrying the durable
 * idempotency key, never more than a real month, a not-paying shop deferred
 * rather than refused, definitive vs ambiguous endings, the admin's
 * evidence-only resolution of an ambiguous ending, expiry, and the dark
 * default (dry run writes nothing).
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

const {
  executeAffiliateCredits,
  expireAffiliateRewards,
  markCreditApplied,
  releaseCreditOperation,
  reserveAffiliateCredits,
  retryCreditOperation,
  runAffiliateCreditExecution,
  STRIPE_IDEMPOTENCY_WINDOW_MS,
} = await import("./affiliateCredit.js");

const NOW = new Date("2026-09-10T12:00:00Z");
const emails: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];
let adminId = "";

function on() {
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  process.env.AFFILIATE_CREDIT_EXECUTION_ENABLED = "true";
  __resetEnvCacheForTests();
}
function off() {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_CREDIT_EXECUTION_ENABLED;
  __resetEnvCacheForTests();
}

async function affiliate(opts: { paying: boolean }) {
  const email = `aff-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: "Aff" }, select: { id: true } });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: `Aff ${randomToken(4)}`,
      slug: `aff-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      ...(opts.paying
        ? { stripeCustomerId: `cus_${randomToken(8)}`, stripeSubscriptionId: `sub_${randomToken(8)}`, subscriptionStatus: "active", plan: "pro" }
        : {}),
    },
    select: { id: true, stripeCustomerId: true },
  });
  shopIds.push(shop.id);
  const referredEmail = `ref-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(referredEmail);
  const referredOwner = await prisma.user.create({ data: { email: referredEmail, name: "Ref" }, select: { id: true } });
  const referred = await prisma.shop.create({
    data: { ownerId: referredOwner.id, name: `Ref ${randomToken(4)}`, slug: `ref-${randomToken(5)}`.toLowerCase(), webhookSecret: randomToken(), bookingMode: "native" },
    select: { id: true },
  });
  shopIds.push(referred.id);
  const now = NOW;
  const { accountId, rewardId } = await runAsOwner(async (tx) => {
    const app = await tx.affiliateApplication.create({
      data: {
        shopId: shop.id,
        submittedByUserId: user.id,
        status: "APPROVED",
        audienceDescription: "x",
        promotionPlan: "y",
        ftcAcknowledgedAt: now,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: now,
        decidedAt: now,
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
      data: { affiliateAccountId: account.id, referredShopId: referred.id, codeUsed: "x", source: "link", state: "ATTRIBUTED", capturedAt: now, lockedAt: now, claimExpiresAt: new Date(now.getTime() + 86_400_000) },
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
        qualifiedAt: now,
        holdEndsAt: now,
        availableAt: now,
        expiresAt: new Date(now.getTime() + 365 * 86_400_000),
      },
      select: { id: true },
    });
    return { accountId: account.id, rewardId: reward.id };
  });
  accountIds.push(accountId);
  return { shopId: shop.id, customerId: shop.stripeCustomerId, accountId, rewardId, referredShopId: referred.id };
}

const rewardStatus = (id: string) =>
  runAsOwner((tx) => tx.affiliateReward.findUnique({ where: { id }, select: { status: true } })).then((r) => r?.status);
const operation = (rewardId: string) =>
  runAsOwner((tx) => tx.affiliateCreditOperation.findUnique({ where: { rewardId } }));

beforeAll(async () => {
  const email = `op-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const admin = await prisma.user.create({ data: { email, name: "Op", isAdmin: true }, select: { id: true } });
  adminId = admin.id;
});

beforeEach(() => {
  retrieve.mockReset();
  createBalanceTransaction.mockReset();
  retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 3499 } }] } });
  // A DISTINCT id per call, like Stripe. One fixed id would make a second
  // reward's settle collide on the transaction-id unique index - which the
  // engine correctly treats as an ambiguous ending, and which is not what
  // this suite is trying to observe.
  createBalanceTransaction.mockImplementation(async () => ({ id: `cbtxn_${randomToken(6)}` }));
  on();
});

afterAll(async () => {
  off();
  await runAsOwner(async (tx) => {
    await tx.affiliateCreditOperation.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.affiliateReward.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateReferralAttribution.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
  });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("dark by default", () => {
  it("with the flag off the job reports and writes nothing", async () => {
    off();
    const f = await affiliate({ paying: true });
    const r = await runAffiliateCreditExecution({ now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.execute).toBeNull();
    expect(r.reserve.due).toBeGreaterThanOrEqual(1);
    expect(await rewardStatus(f.rewardId)).toBe("AVAILABLE");
    expect(await operation(f.rewardId)).toBeNull();
    expect(createBalanceTransaction).not.toHaveBeenCalled();
  });
});

describe("reserve + execute", () => {
  it("applies one credit per reward with the durable idempotency key, never more than a real month", async () => {
    const f = await affiliate({ paying: true });
    // The referrer pays a discounted $29.99 month; the snapshot said $34.99.
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 2999 } }] } });

    const reserve = await reserveAffiliateCredits({ now: NOW });
    expect(reserve.reserved).toBeGreaterThanOrEqual(1);
    expect(await rewardStatus(f.rewardId)).toBe("RESERVED");
    // Reserving again does nothing to it.
    await reserveAffiliateCredits({ now: NOW });
    expect((await operation(f.rewardId))?.status).toBe("PENDING");

    const exec = await executeAffiliateCredits({ now: NOW, batch: 100 });
    expect(exec.applied).toBeGreaterThanOrEqual(1);
    const mine = createBalanceTransaction.mock.calls.filter((c) => c[0] === f.customerId);
    expect(mine).toHaveLength(1);
    const [, body, opts] = mine[0]!;
    expect(body).toMatchObject({ amount: -2999, currency: "usd" });
    expect(opts).toEqual({ idempotencyKey: `affiliate-reward:${f.rewardId}` });

    const op = await operation(f.rewardId);
    expect(op?.status).toBe("APPLIED");
    expect(op?.appliedCents).toBe(2999);
    expect(op?.stripeBalanceTransactionId).toMatch(/^cbtxn_/);
    expect(op?.lastAttemptAmbiguous).toBe(false);
    expect(await rewardStatus(f.rewardId)).toBe("APPLIED");
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({ where: { shopId: f.referredShopId, type: "credit.applied" } }),
    );
    expect(events).toHaveLength(1);

    // A second pass finds nothing to do and calls Stripe again for nobody.
    createBalanceTransaction.mockClear();
    await executeAffiliateCredits({ now: NOW, batch: 100 });
    expect(createBalanceTransaction.mock.calls.filter((c) => c[0] === f.customerId)).toHaveLength(0);
  });

  it("defers a shop that is not paying yet - nothing to apply a credit to - instead of refusing", async () => {
    const f = await affiliate({ paying: false });
    await reserveAffiliateCredits({ now: NOW });
    const exec = await executeAffiliateCredits({ now: NOW, batch: 100 });
    expect(exec.deferred).toBeGreaterThanOrEqual(1);
    const op = await operation(f.rewardId);
    expect(op?.status).toBe("PENDING");
    expect(op?.lastError).toBe("not_paying");
    expect(op?.attempts).toBe(0);
    expect(op!.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await rewardStatus(f.rewardId)).toBe("RESERVED");
    expect(createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("a definitive Stripe rejection retries with backoff and gives up as FAILED; an admin may retry it", async () => {
    const f = await affiliate({ paying: true });
    await reserveAffiliateCredits({ now: NOW });
    createBalanceTransaction.mockRejectedValue(Object.assign(new Error("bad request"), { type: "StripeInvalidRequestError" }));
    let t = NOW;
    let last = "";
    for (let i = 0; i < 6; i++) {
      const r = await executeAffiliateCredits({ now: t, batch: 100 });
      last = r.failed > 0 ? "failed" : r.retry > 0 ? "retry" : last;
      t = new Date(t.getTime() + 2 * 60 * 60 * 1000);
    }
    const op = await operation(f.rewardId);
    expect(op?.status).toBe("FAILED");
    expect(op?.lastAttemptAmbiguous).toBe(false);
    expect(op?.attempts).toBe(5);
    expect(await rewardStatus(f.rewardId)).toBe("RESERVED");

    const retry = await retryCreditOperation({ operationId: op!.id, adminUserId: adminId });
    expect(retry.ok).toBe(true);
    expect((await operation(f.rewardId))?.status).toBe("PENDING");
    expect((await retryCreditOperation({ operationId: op!.id, adminUserId: adminId })).ok).toBe(false);
  });

  it("🔴 an ambiguous ending past Stripe's window is ABANDONED, and only evidence resolves it", async () => {
    const f = await affiliate({ paying: true });
    await reserveAffiliateCredits({ now: NOW });
    createBalanceTransaction.mockRejectedValue(new Error("socket hang up"));
    const first = await executeAffiliateCredits({ now: NOW, batch: 100 });
    expect(first.retry).toBeGreaterThanOrEqual(1);
    let op = await operation(f.rewardId);
    expect(op?.status).toBe("PENDING");
    expect(op?.lastAttemptAmbiguous).toBe(true);

    // The next pass lands after the 24h idempotency window: a fresh request
    // could credit twice, so nothing is sent and the row is abandoned.
    const later = new Date(NOW.getTime() + STRIPE_IDEMPOTENCY_WINDOW_MS + 60_000);
    createBalanceTransaction.mockClear();
    await executeAffiliateCredits({ now: later, batch: 100 });
    op = await operation(f.rewardId);
    expect(op?.status).toBe("ABANDONED");
    expect(op?.lastError).toBe("idempotency_window_expired");
    expect(createBalanceTransaction.mock.calls.filter((c) => c[0] === f.customerId)).toHaveLength(0);

    // Retry is refused for an ambiguous ending - only evidence resolves it.
    expect((await retryCreditOperation({ operationId: op!.id, adminUserId: adminId })).ok).toBe(false);
    const marked = await markCreditApplied({
      operationId: op!.id,
      adminUserId: adminId,
      stripeBalanceTransactionId: `cbtxn_${randomToken(6)}`,
      now: later,
    });
    expect(marked.ok).toBe(true);
    expect((await operation(f.rewardId))?.status).toBe("APPLIED");
    expect(await rewardStatus(f.rewardId)).toBe("APPLIED");
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({ where: { shopId: f.referredShopId, type: "credit.adjusted" } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(adminId);
  });

  it("release hands a FAILED reward back, and the next reserve re-arms the same operation", async () => {
    const f = await affiliate({ paying: true });
    await reserveAffiliateCredits({ now: NOW });
    createBalanceTransaction.mockRejectedValue(Object.assign(new Error("no"), { type: "StripeInvalidRequestError" }));
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      await executeAffiliateCredits({ now: t, batch: 100 });
      t = new Date(t.getTime() + 2 * 60 * 60 * 1000);
    }
    const op = await operation(f.rewardId);
    expect(op?.status).toBe("FAILED");
    const released = await releaseCreditOperation({ operationId: op!.id, adminUserId: adminId });
    expect(released.ok).toBe(true);
    expect(await rewardStatus(f.rewardId)).toBe("AVAILABLE");
    expect((await operation(f.rewardId))?.status).toBe("CANCELED");

    await reserveAffiliateCredits({ now: t });
    const again = await operation(f.rewardId);
    expect(again?.id).toBe(op!.id);
    expect(again?.status).toBe("PENDING");
    expect(again?.attempts).toBe(0);
  });
});

describe("expiry", () => {
  it("an AVAILABLE reward past its expiry becomes EXPIRED with an audit event; a pending operation is canceled with it", async () => {
    const f = await affiliate({ paying: false });
    await runAsOwner((tx) =>
      tx.affiliateReward.update({ where: { id: f.rewardId }, data: { expiresAt: new Date(NOW.getTime() - 1000) } }),
    );
    // Reserved but never applied (not paying) - it expires too.
    await reserveAffiliateCredits({ now: NOW });
    expect(await rewardStatus(f.rewardId)).toBe("RESERVED");
    const r = await expireAffiliateRewards({ now: NOW });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await rewardStatus(f.rewardId)).toBe("EXPIRED");
    expect((await operation(f.rewardId))?.status).toBe("CANCELED");
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({ where: { shopId: f.referredShopId, type: "reward.expired" } }),
    );
    expect(events).toHaveLength(1);
  });

  it("never expires a reward whose credit already landed", async () => {
    const f = await affiliate({ paying: true });
    await reserveAffiliateCredits({ now: NOW });
    await executeAffiliateCredits({ now: NOW, batch: 100 });
    expect(await rewardStatus(f.rewardId)).toBe("APPLIED");
    await runAsOwner((tx) =>
      tx.affiliateReward.update({ where: { id: f.rewardId }, data: { expiresAt: new Date(NOW.getTime() - 1000) } }),
    );
    await expireAffiliateRewards({ now: NOW });
    expect(await rewardStatus(f.rewardId)).toBe("APPLIED");
  });
});
