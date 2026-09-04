import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * The legacy referral reward, hardened:
 *   - the Stripe credit carries a durable idempotency key (the referral's own
 *     id) and the balance transaction id comes back and is STORED
 *   - the invoice that paid the referrer is recorded, so a refund, dispute or
 *     credit note against THAT invoice flags the referral for a person -
 *     once, and without moving any money
 *   - a second grant for one referred shop is impossible (unique + CAS), and
 *     a replayed invoice cannot pay twice
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

const { grantReferralReward, flagReferralForReview, auditReferralGrants } = await import("./referral.js");
const { applyStripeEvent } = await import("../billing/stripe.js");

const userIds: string[] = [];
const shopIds: string[] = [];

async function shop(name: string, data: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `ref-int-${randomToken(6)}@test.local`, name },
    select: { id: true },
  });
  userIds.push(user.id);
  const s = await prisma.shop.create({
    data: { ownerId: user.id, name, bookingUrl: "https://ref.test", webhookSecret: randomToken(), ...data },
    select: { id: true },
  });
  shopIds.push(s.id);
  return s.id;
}

async function payingReferrer(): Promise<string> {
  return shop("Payer Cuts", {
    stripeCustomerId: `cus_ref_${randomToken(8)}`,
    stripeSubscriptionId: `sub_ref_${randomToken(8)}`,
    subscriptionStatus: "active",
    plan: "pro",
  });
}

async function referred(referrerShopId: string): Promise<{ shopId: string; referralId: string }> {
  const shopId = await shop("Friend Cuts", { stripeCustomerId: `cus_friend_${randomToken(8)}` });
  const r = await prisma.referral.create({
    data: { referrerShopId, referredShopId: shopId, code: "CODE", status: "PENDING" },
    select: { id: true },
  });
  return { shopId, referralId: r.id };
}

beforeAll(() => {
  retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 3499 } }] } });
});
beforeEach(() => {
  createBalanceTransaction.mockReset();
  createBalanceTransaction.mockImplementation(async () => ({ id: `cbtxn_${randomToken(6)}` }));
});
afterAll(async () => {
  await prisma.referral.deleteMany({ where: { referredShopId: { in: shopIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("legacy referral credit", () => {
  it("passes a durable idempotency key and stores the balance transaction id and the qualifying invoice", async () => {
    const referrer = await payingReferrer();
    const { shopId, referralId } = await referred(referrer);
    createBalanceTransaction.mockResolvedValueOnce({ id: "cbtxn_stored" });
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_first" });
    expect(createBalanceTransaction).toHaveBeenCalledTimes(1);
    const [, params, opts] = createBalanceTransaction.mock.calls[0]!;
    expect(params.amount).toBe(-3499);
    expect(params.metadata).toEqual({ referralId });
    expect(opts).toEqual({ idempotencyKey: `referral-reward:${referralId}` });
    const row = await prisma.referral.findUnique({ where: { id: referralId } });
    expect(row?.status).toBe("REWARDED");
    expect(row?.rewardKind).toBe("stripe_credit");
    expect(row?.rewardAmountCents).toBe(3499);
    expect(row?.stripeBalanceTransactionId).toBe("cbtxn_stored");
    expect(row?.qualifyingInvoiceId).toBe("in_first");
  });

  it("a replayed or renewed invoice cannot pay a second time", async () => {
    const referrer = await payingReferrer();
    const { shopId } = await referred(referrer);
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_a" });
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_a" });
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_b" });
    expect(createBalanceTransaction).toHaveBeenCalledTimes(1);
    const row = await prisma.referral.findUnique({ where: { referredShopId: shopId } });
    expect(row?.qualifyingInvoiceId).toBe("in_a");
  });

  it("the balance transaction id is unique: one credit cannot be recorded on two referrals", async () => {
    const referrer = await payingReferrer();
    const a = await referred(referrer);
    const b = await referred(referrer);
    await prisma.referral.update({ where: { id: a.referralId }, data: { stripeBalanceTransactionId: "cbtxn_one" } });
    await expect(
      prisma.referral.update({ where: { id: b.referralId }, data: { stripeBalanceTransactionId: "cbtxn_one" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("a refund of the qualifying invoice flags the referral once and moves no money", async () => {
    const referrer = await payingReferrer();
    const { shopId, referralId } = await referred(referrer);
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_refunded" });
    createBalanceTransaction.mockClear();

    expect(await flagReferralForReview("in_refunded", "invoice_refunded")).toBe(1);
    let row = await prisma.referral.findUnique({ where: { id: referralId } });
    expect(row?.status).toBe("REWARDED"); // not reversed - a person decides
    expect(row?.reviewFlaggedAt).not.toBeNull();
    expect(row?.reviewReason).toBe("invoice_refunded");
    // Redelivered, or a dispute on top of the refund: the first flag stands.
    expect(await flagReferralForReview("in_refunded", "invoice_refunded")).toBe(0);
    expect(await flagReferralForReview("in_refunded", "payment_disputed")).toBe(0);
    row = await prisma.referral.findUnique({ where: { id: referralId } });
    expect(row?.reviewReason).toBe("invoice_refunded");
    // Some other invoice of the same customer flags nothing.
    expect(await flagReferralForReview("in_other", "invoice_refunded")).toBe(0);
    // And no positive balance transaction was ever issued.
    expect(createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("the webhook reducer routes charge.refunded / dispute / credit note to the flag", async () => {
    const referrer = await payingReferrer();
    const { shopId, referralId } = await referred(referrer);
    await grantReferralReward(shopId, { qualifyingInvoiceId: "in_disputed" });
    await applyStripeEvent({
      id: `evt_${randomToken(6)}`,
      object: "event",
      type: "charge.dispute.created",
      data: { object: { object: "dispute", invoice: "in_disputed" } },
    } as never);
    const row = await prisma.referral.findUnique({ where: { id: referralId } });
    expect(row?.reviewReason).toBe("payment_disputed");
    const credit = await referred(referrer);
    await grantReferralReward(credit.shopId, { qualifyingInvoiceId: "in_credited" });
    await applyStripeEvent({
      id: `evt_${randomToken(6)}`,
      object: "event",
      type: "credit_note.created",
      data: { object: { object: "credit_note", invoice: { id: "in_credited" } } },
    } as never);
    expect((await prisma.referral.findUnique({ where: { id: credit.referralId } }))?.reviewReason).toBe(
      "credit_note",
    );
  });

  it("the grant audit reports flagged rewards alongside stranded ones, ids only", async () => {
    const res = await auditReferralGrants();
    expect(res.flagged).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toMatch(/@|Payer Cuts|Friend Cuts/);
  });
});
