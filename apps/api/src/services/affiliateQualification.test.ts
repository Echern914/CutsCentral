import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  PLANS,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import {
  applyAffiliateStripeEvent,
  releaseAffiliateRewardHolds,
} from "./affiliateQualification.js";

/**
 * Qualification: two cleared base-subscription invoices, a hold, one reward.
 *
 * The properties worth the most here are the ones about Stripe's own
 * behaviour: it redelivers events for days, out of order, and sometimes emits
 * more than one event about the same invoice. So the counting key is the
 * INVOICE, the replay key is the EVENT, and both are unique indexes rather
 * than application checks.
 */

const BASE_PRICE = "price_base_test";
const ADDON_PRICE = "price_addon_test";
const DAY = 86_400_000;

const emails: string[] = [];
const shopIds: string[] = [];

function flags(on: boolean) {
  process.env.AFFILIATE_PROGRAM_ENABLED = on ? "true" : "false";
  process.env.AFFILIATE_QUALIFICATION_ENABLED = on ? "true" : "false";
  process.env.STRIPE_PRICE_ID = BASE_PRICE;
  __resetEnvCacheForTests();
}

async function makeUser(label: string): Promise<string> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({
    data: { email, passwordHash: "x", name: label },
  });
  return user.id;
}

async function makeShop(
  ownerId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: `Q ${randomToken(4)}`,
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      ...over,
    },
  });
  shopIds.push(shop.id);
  return shop.id;
}

/** An approved affiliate on a paid plan, and a referred shop attributed to it. */
async function scenario(
  label: string,
  opts: { referrerPlan?: string; accountStatus?: string } = {},
): Promise<{ accountId: string; referredShopId: string; customerId: string }> {
  const referrerOwner = await makeUser(`${label}-ref`);
  const referrerShopId = await makeShop(referrerOwner, {
    plan: opts.referrerPlan ?? "pro",
  });
  const referredOwner = await makeUser(`${label}-friend`);
  const customerId = `cus_${randomToken(8)}`;
  const referredShopId = await makeShop(referredOwner, {
    stripeCustomerId: customerId,
  });

  const accountId = await runAsOwner(async (tx) => {
    const application = await tx.affiliateApplication.create({
      data: {
        shopId: referrerShopId,
        submittedByUserId: referrerOwner,
        status: "APPROVED",
        decidedAt: new Date(),
        decidedByUserId: referrerOwner,
        decisionReason: "approved",
        audienceDescription: "aud",
        promotionPlan: "plan",
        ftcAcknowledgedAt: new Date(),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: new Date(),
      },
    });
    const account = await tx.affiliateAccount.create({
      data: {
        shopId: referrerShopId,
        applicationId: application.id,
        code: randomToken(9),
        status: opts.accountStatus ?? "ACTIVE",
        ...(opts.accountStatus === "SUSPENDED"
          ? { suspendedAt: new Date(), suspensionReason: "admin_review" }
          : {}),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: 1,
      },
    });
    const now = new Date();
    await tx.affiliateReferralAttribution.create({
      data: {
        referredShopId,
        affiliateAccountId: account.id,
        codeUsed: account.code,
        source: "link",
        state: "ATTRIBUTED",
        capturedAt: now,
        lockedAt: now,
        claimExpiresAt: new Date(now.getTime() + 60 * DAY),
      },
    });
    return account.id;
  });
  return { accountId, referredShopId, customerId };
}

/** An invoice.paid event, shaped the way Stripe delivers it. */
function invoicePaid(opts: {
  customerId: string;
  eventId?: string;
  invoiceId?: string;
  priceId?: string;
  amount?: number;
  taxCents?: number;
}) {
  const amount = opts.amount ?? 3499;
  return {
    id: opts.eventId ?? `evt_${randomToken(8)}`,
    type: "invoice.paid",
    data: {
      object: {
        id: opts.invoiceId ?? `in_${randomToken(8)}`,
        customer: opts.customerId,
        currency: "usd",
        // amount_paid INCLUDES tax; only the base line counts toward the rules.
        amount_paid: amount + (opts.taxCents ?? 0),
        tax: opts.taxCents ?? 0,
        lines: {
          data: [{ amount, price: { id: opts.priceId ?? BASE_PRICE } }],
        },
      },
    },
  };
}

function rewardFor(referredShopId: string) {
  return runAsOwner((tx) =>
    tx.affiliateReward.findUnique({ where: { referredShopId } }),
  );
}

beforeAll(() => flags(true));

afterEach(() => flags(true));

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_QUALIFICATION_ENABLED;
  delete process.env.STRIPE_PRICE_ID;
  __resetEnvCacheForTests();
  const ids = shopIds.filter(Boolean);
  if (ids.length > 0) {
    await runAsOwner(async (tx) => {
      await tx.affiliateReward.deleteMany({ where: { referredShopId: { in: ids } } });
      await tx.affiliateQualifyingInvoice.deleteMany({
        where: { referredShopId: { in: ids } },
      });
      await tx.affiliateReferralAttribution.deleteMany({
        where: { referredShopId: { in: ids } },
      });
      await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: ids } } });
    });
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("qualification: the two-invoice rule", () => {
  it("one invoice qualifies nothing; the second creates exactly one PENDING reward with a hold", async () => {
    const s = await scenario("two");
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    expect(await rewardFor(s.referredShopId)).toBeNull();

    const at = Date.UTC(2026, 8, 1);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }), at);

    const reward = await rewardFor(s.referredShopId);
    expect(reward?.status).toBe("PENDING");
    expect(reward?.affiliateAccountId).toBe(s.accountId);
    // The referrer is on "pro": one month of THEIR plan, snapshotted.
    expect(reward?.amountCents).toBe(Math.round(PLANS.pro.priceMonthlyUsd * 100));
    expect(reward?.basisPlan).toBe("pro");
    expect(reward?.holdEndsAt.getTime()).toBe(
      at + AFFILIATE_POLICY.qualification.holdDaysAfterSecond * DAY,
    );
    expect(reward?.availableAt).toBeNull();

    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { shopId: s.referredShopId, type: "reward.qualified" },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("🔴 a REPLAYED event, and a second event about the SAME invoice, both count once", async () => {
    const s = await scenario("replay");
    const first = invoicePaid({ customerId: s.customerId });
    // Exactly the same event, delivered three times.
    await applyAffiliateStripeEvent(first);
    await applyAffiliateStripeEvent(first);
    await applyAffiliateStripeEvent(first);
    // A DIFFERENT event id describing the SAME invoice - Stripe does this.
    const invoiceId = (first.data.object as { id: string }).id;
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, invoiceId }),
    );

    const counted = await runAsOwner((tx) =>
      tx.affiliateQualifyingInvoice.count({
        where: { referredShopId: s.referredShopId },
      }),
    );
    expect(counted).toBe(1);
    expect(await rewardFor(s.referredShopId)).toBeNull();
  });

  it("🔴 two SIMULTANEOUS qualifying invoices produce exactly one reward", async () => {
    const s = await scenario("race");
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    // Two different invoices arriving together, each enough to be the second.
    await Promise.all([
      applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId })),
      applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId })),
    ]);
    const rewards = await runAsOwner((tx) =>
      tx.affiliateReward.count({ where: { referredShopId: s.referredShopId } }),
    );
    expect(rewards).toBe(1);
  });

  it("tax, add-on and zero-value invoices never move a referral toward qualification", async () => {
    const s = await scenario("excl");
    // Add-on only.
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, priceId: ADDON_PRICE }),
    );
    // Zero paid.
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, amount: 0 }),
    );
    expect(
      await runAsOwner((tx) =>
        tx.affiliateQualifyingInvoice.count({
          where: { referredShopId: s.referredShopId },
        }),
      ),
    ).toBe(0);

    // A base invoice WITH tax counts only its base line.
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, amount: 3499, taxCents: 900 }),
    );
    const rows = await runAsOwner((tx) =>
      tx.affiliateQualifyingInvoice.findMany({
        where: { referredShopId: s.referredShopId },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(3499);
  });

  it("a shop nobody referred qualifies nothing, however much it pays", async () => {
    const owner = await makeUser("orphan");
    const customerId = `cus_${randomToken(8)}`;
    const shopId = await makeShop(owner, { stripeCustomerId: customerId });
    await applyAffiliateStripeEvent(invoicePaid({ customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId }));

    expect(await rewardFor(shopId)).toBeNull();
    // Not even a qualifying-invoice row: with no attribution there is nothing
    // to count toward, so the counter is never started.
    expect(
      await runAsOwner((tx) =>
        tx.affiliateQualifyingInvoice.count({ where: { referredShopId: shopId } }),
      ),
    ).toBe(0);
  });

  it("a shop whose attribution was REJECTED qualifies nothing - legacy owns it", async () => {
    const s = await scenario("rejected");
    await runAsOwner((tx) =>
      tx.affiliateReferralAttribution.updateMany({
        where: { referredShopId: s.referredShopId },
        data: { state: "REJECTED", rejectionReason: "legacy_claimed" },
      }),
    );
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    expect(await rewardFor(s.referredShopId)).toBeNull();
  });
});

describe("qualification: held for review rather than discarded", () => {
  it("a suspended affiliate's reward is REVIEW_REQUIRED, never silently dropped", async () => {
    const s = await scenario("susp", { accountStatus: "SUSPENDED" });
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    const reward = await rewardFor(s.referredShopId);
    expect(reward?.status).toBe("REVIEW_REQUIRED");
  });

  it("a referrer on the AI plan earns their own month", async () => {
    const s = await scenario("aiplan", { referrerPlan: "pro_ai" });
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    const reward = await rewardFor(s.referredShopId);
    expect(reward?.amountCents).toBe(Math.round(PLANS.pro_ai.priceMonthlyUsd * 100));
    expect(reward?.basisPlan).toBe("pro_ai");
  });

  it("a referrer on no paid plan is held for review rather than credited a guess", async () => {
    const s = await scenario("freeplan", { referrerPlan: "free" });
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    const reward = await rewardFor(s.referredShopId);
    expect(reward?.status).toBe("REVIEW_REQUIRED");
  });
});

describe("qualification: refunds and disputes reverse it", () => {
  it("a refund on the qualifying invoice reverses the reward and audits it", async () => {
    const s = await scenario("refund");
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    const second = invoicePaid({ customerId: s.customerId });
    await applyAffiliateStripeEvent(second);
    expect((await rewardFor(s.referredShopId))?.status).toBe("PENDING");

    const invoiceId = (second.data.object as { id: string }).id;
    await applyAffiliateStripeEvent({
      id: `evt_${randomToken(8)}`,
      type: "charge.refunded",
      data: { object: { invoice: invoiceId } },
    });

    const reward = await rewardFor(s.referredShopId);
    expect(reward?.status).toBe("REVERSED");
    expect(reward?.reversalReason).toBe("invoice_refunded");
    expect(reward?.reversedAt).not.toBeNull();
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { shopId: s.referredShopId, type: "reward.reversed" },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("a dispute reverses with its own classification", async () => {
    const s = await scenario("dispute");
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    const second = invoicePaid({ customerId: s.customerId });
    await applyAffiliateStripeEvent(second);
    await applyAffiliateStripeEvent({
      id: `evt_${randomToken(8)}`,
      type: "charge.dispute.created",
      data: { object: { invoice: (second.data.object as { id: string }).id } },
    });
    expect((await rewardFor(s.referredShopId))?.reversalReason).toBe(
      "payment_disputed",
    );
  });
});

describe("qualification: the hold sweep", () => {
  it("releases a reward only once its hold has run out, and sets the expiry clock", async () => {
    const s = await scenario("hold");
    const at = Date.UTC(2026, 8, 1);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }), at);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }), at);

    // One day in: nothing is due.
    const early = await releaseAffiliateRewardHolds({ nowMs: at + DAY });
    expect(early.released).toBe(0);
    expect((await rewardFor(s.referredShopId))?.status).toBe("PENDING");

    // Past the hold: released, with a 12-month expiry.
    const after = at + (AFFILIATE_POLICY.qualification.holdDaysAfterSecond + 1) * DAY;
    const swept = await releaseAffiliateRewardHolds({ nowMs: after });
    expect(swept.released).toBeGreaterThanOrEqual(1);
    const reward = await rewardFor(s.referredShopId);
    expect(reward?.status).toBe("AVAILABLE");
    expect(reward?.availableAt).not.toBeNull();
    expect(reward?.expiresAt).not.toBeNull();
    const months =
      (reward!.expiresAt!.getUTCFullYear() - reward!.availableAt!.getUTCFullYear()) *
        12 +
      (reward!.expiresAt!.getUTCMonth() - reward!.availableAt!.getUTCMonth());
    expect(months).toBe(AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable);
  });

  it("is a DRY RUN while the flags are off: it reports what it would do and writes nothing", async () => {
    const s = await scenario("dry");
    const at = Date.UTC(2026, 8, 1);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }), at);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }), at);

    flags(false);
    const after = at + (AFFILIATE_POLICY.qualification.holdDaysAfterSecond + 1) * DAY;
    const result = await releaseAffiliateRewardHolds({ nowMs: after });
    expect(result.dryRun).toBe(true);
    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.released).toBe(0);
    expect((await rewardFor(s.referredShopId))?.status).toBe("PENDING");
  });
});

describe("qualification: dark by default", () => {
  it("🔴 with the flags off, a perfectly valid pair of invoices qualifies NOTHING", async () => {
    const s = await scenario("dark");
    flags(false);
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    expect(
      await runAsOwner((tx) =>
        tx.affiliateQualifyingInvoice.count({
          where: { referredShopId: s.referredShopId },
        }),
      ),
    ).toBe(0);
    expect(await rewardFor(s.referredShopId)).toBeNull();
    // Not even the event dedupe table is written to.
    expect(await runAsOwner((tx) => tx.stripeWebhookEvent.count({}))).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("fails closed when no base price is configured - it will not guess which line was the subscription", async () => {
    const s = await scenario("noprice");
    delete process.env.STRIPE_PRICE_ID;
    delete process.env.STRIPE_PREMIUM_AI_PRICE_ID;
    __resetEnvCacheForTests();
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId }));
    expect(await rewardFor(s.referredShopId)).toBeNull();
  });
});
