import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";

/**
 * DOLLAR ACCOUNT CREDIT (the owner's 2026-10-30 decision): an affiliate earns
 * AFFILIATE_POLICY.dollarCredit.signupCents when a business they brought on
 * pays its FIRST invoice, and monthlyCents for every later paid invoice, for
 * as long as it pays - all as credit on their own ChairBack bill, through the
 * existing credit operation. Never cash.
 *
 * Pinned here:
 *  - nothing at bare signup, or on a free / zero invoice - only paid money;
 *  - first paid invoice -> exactly one sign-up credit; each later -> one
 *    monthly credit;
 *  - 🔴 the same invoice never earns twice (replay, a second event id, out of
 *    order) - the stripeInvoiceId unique key;
 *  - a refund / dispute reverses THAT invoice's credit and nothing else;
 *  - a business that stops paying stops earning;
 *  - the month-off style is untouched, and switching style is forward-only;
 *  - flags off -> nothing;
 *  - execution applies EXACTLY the reward's cents with the stable key, never
 *    reads the plan price, and defers (never expires) an affiliate who is not
 *    paying yet.
 *
 * Clocks are pinned to a fixed PAST instant (test-date-bomb rule).
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

const { applyAffiliateStripeEvent, releaseAffiliateRewardHolds } = await import(
  "./affiliateQualification.js"
);
const { setAffiliateRewardStyle } = await import("./affiliateOverview.js");
const { executeAffiliateCredits, expireAffiliateRewards, reserveAffiliateCredits } =
  await import("../engines/affiliateCredit.js");

const BASE_PRICE = "price_base_dollar_test";
const ADDON_PRICE = "price_addon_dollar_test";
const DAY = 86_400_000;
const HOLD_MS = AFFILIATE_POLICY.qualification.holdDaysAfterSecond * DAY;
const SIGNUP = AFFILIATE_POLICY.dollarCredit.signupCents;
const MONTHLY = AFFILIATE_POLICY.dollarCredit.monthlyCents;
/** A fixed instant in the PAST. Every clock in this file hangs off it. */
const T0 = Date.UTC(2026, 2, 2, 15);

const emails: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];

function flags(opts: { qualification?: boolean; execution?: boolean } = {}) {
  const q = opts.qualification ?? true;
  process.env.AFFILIATE_PROGRAM_ENABLED = q ? "true" : "false";
  process.env.AFFILIATE_QUALIFICATION_ENABLED = q ? "true" : "false";
  process.env.AFFILIATE_CREDIT_EXECUTION_ENABLED = (opts.execution ?? true) ? "true" : "false";
  // Retired: on or off, it must change nothing here.
  process.env.AFFILIATE_COMMISSIONS_ENABLED = "true";
  process.env.STRIPE_PRICE_ID = BASE_PRICE;
  __resetEnvCacheForTests();
}

async function makeUser(label: string): Promise<string> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: "x", name: label } });
  return user.id;
}

async function makeShop(ownerId: string, over: Record<string, unknown> = {}): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: `D ${randomToken(4)}`,
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      ...over,
    },
  });
  shopIds.push(shop.id);
  return shop.id;
}

interface Affiliate {
  ownerUserId: string;
  accountId: string;
  affiliateShopId: string;
  affiliateCustomerId: string | null;
}

/** An approved affiliate. `paying` = the affiliate has a live subscription
 *  a credit can land on. */
async function affiliate(
  label: string,
  opts: { style?: "dollar_credit" | "month_off"; paying?: boolean; status?: string } = {},
): Promise<Affiliate> {
  const owner = await makeUser(`${label}-aff`);
  const paying = opts.paying ?? true;
  const customerId = paying ? `cus_${randomToken(8)}` : null;
  const affiliateShopId = await makeShop(owner, {
    plan: "pro",
    ...(paying
      ? {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub_${randomToken(8)}`,
          subscriptionStatus: "active",
        }
      : {}),
  });
  const accountId = await runAsOwner(async (tx) => {
    const application = await tx.affiliateApplication.create({
      data: {
        shopId: affiliateShopId,
        submittedByUserId: owner,
        status: "APPROVED",
        decidedAt: new Date(T0),
        decidedByUserId: owner,
        decisionReason: "approved",
        audienceDescription: "aud",
        promotionPlan: "plan",
        ftcAcknowledgedAt: new Date(T0),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: new Date(T0),
      },
    });
    const account = await tx.affiliateAccount.create({
      data: {
        shopId: affiliateShopId,
        applicationId: application.id,
        code: randomToken(9),
        status: opts.status ?? "ACTIVE",
        ...(opts.status === "SUSPENDED"
          ? { suspendedAt: new Date(T0), suspensionReason: "admin_review" }
          : {}),
        // Omitted = the database default, which is what a new affiliate gets.
        ...(opts.style ? { rewardStyle: opts.style } : {}),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: AFFILIATE_POLICY_VERSION,
      },
    });
    return account.id;
  });
  accountIds.push(accountId);
  return { ownerUserId: owner, accountId, affiliateShopId, affiliateCustomerId: customerId };
}

interface Business {
  referredShopId: string;
  customerId: string;
}

/** A business that signed up through the affiliate's link. Signing up is
 *  all it has done: no invoice yet. */
async function bringOn(a: Affiliate, label: string): Promise<Business> {
  const owner = await makeUser(`${label}-biz`);
  const customerId = `cus_${randomToken(8)}`;
  const referredShopId = await makeShop(owner, { stripeCustomerId: customerId });
  await runAsOwner((tx) =>
    tx.affiliateReferralAttribution.create({
      data: {
        referredShopId,
        affiliateAccountId: a.accountId,
        codeUsed: "x",
        source: "link",
        state: "ATTRIBUTED",
        capturedAt: new Date(T0),
        lockedAt: new Date(T0),
        claimExpiresAt: new Date(T0 + 60 * DAY),
      },
    }),
  );
  return { referredShopId, customerId };
}

function invoicePaid(opts: {
  customerId: string;
  invoiceId?: string;
  eventId?: string;
  amount?: number;
  amountPaid?: number;
  priceId?: string;
  paidAtMs?: number;
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
        amount_paid: opts.amountPaid ?? amount,
        tax: 0,
        status_transitions: { paid_at: Math.floor((opts.paidAtMs ?? T0) / 1000) },
        lines: { data: [{ amount, price: { id: opts.priceId ?? BASE_PRICE } }] },
      },
    },
  };
}

const invoiceIdOf = (e: ReturnType<typeof invoicePaid>) => (e.data.object as { id: string }).id;

/** The business pays one invoice at `atMs`; returns the invoice id. */
async function pays(b: Business, atMs: number, over: Partial<Parameters<typeof invoicePaid>[0]> = {}) {
  const e = invoicePaid({ customerId: b.customerId, paidAtMs: atMs, ...over });
  await applyAffiliateStripeEvent(e, atMs);
  return invoiceIdOf(e);
}

async function refund(invoiceId: string, type = "charge.refunded", atMs = T0) {
  await applyAffiliateStripeEvent(
    { id: `evt_${randomToken(8)}`, type, data: { object: { invoice: invoiceId } } },
    atMs,
  );
}

function rewardsOf(referredShopId: string) {
  return runAsOwner((tx) =>
    tx.affiliateReward.findMany({ where: { referredShopId }, orderBy: { qualifiedAt: "asc" } }),
  );
}

function rewardForInvoice(stripeInvoiceId: string) {
  return runAsOwner((tx) => tx.affiliateReward.findUnique({ where: { stripeInvoiceId } }));
}

function audit(referredShopId: string, type: string) {
  return runAsOwner((tx) =>
    tx.affiliateAuditEvent.findMany({ where: { shopId: referredShopId, type } }),
  );
}

beforeAll(() => {
  // Date only: timers stay real so the database driver keeps working.
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  flags();
});

beforeEach(() => {
  vi.setSystemTime(T0);
  retrieve.mockReset();
  createBalanceTransaction.mockReset();
  retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 3499 } }] } });
  createBalanceTransaction.mockImplementation(async () => ({ id: `cbtxn_${randomToken(6)}` }));
});

afterEach(() => flags());

afterAll(async () => {
  vi.useRealTimers();
  for (const k of [
    "AFFILIATE_PROGRAM_ENABLED",
    "AFFILIATE_QUALIFICATION_ENABLED",
    "AFFILIATE_CREDIT_EXECUTION_ENABLED",
    "AFFILIATE_COMMISSIONS_ENABLED",
    "STRIPE_PRICE_ID",
  ]) {
    delete process.env[k];
  }
  __resetEnvCacheForTests();
  const ids = shopIds.filter(Boolean);
  await runAsOwner(async (tx) => {
    await tx.affiliateCreditOperation.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateCommission.deleteMany({ where: { referredShopId: { in: ids } } });
    await tx.affiliateReward.deleteMany({ where: { referredShopId: { in: ids } } });
    await tx.affiliateQualifyingInvoice.deleteMany({ where: { referredShopId: { in: ids } } });
    await tx.affiliateReferralAttribution.deleteMany({ where: { referredShopId: { in: ids } } });
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: ids } } });
    await tx.affiliateAccount.deleteMany({ where: { id: { in: accountIds } } });
    await tx.affiliateApplication.deleteMany({ where: { shopId: { in: ids } } });
    // EmailIntent has no foreign key to Shop: a leftover PENDING intent would
    // sit in another suite's outbox drain.
    await tx.emailIntent.deleteMany({ where: { shopId: { in: ids } } });
  });
  await prisma.shop.deleteMany({ where: { id: { in: ids } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

describe("dollar credit: earning", () => {
  it("a new affiliate is on dollar credit by default", async () => {
    const a = await affiliate("default");
    const row = await runAsOwner((tx) =>
      tx.affiliateAccount.findUniqueOrThrow({ where: { id: a.accountId } }),
    );
    expect(row.rewardStyle).toBe("dollar_credit");
  });

  it("🔴 a bare signup earns NOTHING, nor does a trial or add-on invoice that paid nothing for the plan", async () => {
    const a = await affiliate("bare");
    const b = await bringOn(a, "bare");
    expect(await rewardsOf(b.referredShopId)).toHaveLength(0);

    // A free trial's $0 invoice, then an add-on-only charge.
    await pays(b, T0, { amount: 0, amountPaid: 0 });
    await pays(b, T0 + DAY, { priceId: ADDON_PRICE });
    expect(await rewardsOf(b.referredShopId)).toHaveLength(0);
  });

  it("the FIRST paid invoice earns exactly one sign-up credit, PENDING behind the hold", async () => {
    const a = await affiliate("first");
    const b = await bringOn(a, "first");
    const inv = await pays(b, T0);

    const rows = await rewardsOf(b.referredShopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rewardType: "signup_credit",
      amountCents: SIGNUP,
      currency: "usd",
      status: "PENDING",
      stripeInvoiceId: inv,
      affiliateAccountId: a.accountId,
      expiresAt: null,
    });
    expect(rows[0]!.holdEndsAt.getTime()).toBe(T0 + HOLD_MS);
    expect(await audit(b.referredShopId, "reward.qualified")).toHaveLength(1);
    // The retired commission ledger stays empty even with its flag on.
    expect(
      await runAsOwner((tx) =>
        tx.affiliateCommission.count({ where: { referredShopId: b.referredShopId } }),
      ),
    ).toBe(0);
  });

  it("every LATER paid invoice earns one monthly credit, for as long as the business pays", async () => {
    const a = await affiliate("later");
    const b = await bringOn(a, "later");
    const invoices = [];
    for (let m = 0; m < 4; m++) invoices.push(await pays(b, T0 + m * 30 * DAY));

    const rows = await rewardsOf(b.referredShopId);
    expect(rows.map((r) => [r.rewardType, r.amountCents])).toEqual([
      ["signup_credit", SIGNUP],
      ["monthly_credit", MONTHLY],
      ["monthly_credit", MONTHLY],
      ["monthly_credit", MONTHLY],
    ]);
    expect(rows.map((r) => r.stripeInvoiceId)).toEqual(invoices);
    // Monthly credits never trip the "new business" email: one email, for
    // the sign-up credit only.
    const intents = await runAsOwner((tx) =>
      tx.emailIntent.count({
        where: { shopId: a.affiliateShopId, kind: "affiliate_reward_qualified" },
      }),
    );
    expect(intents).toBe(1);
  });

  it("🔴 a REPLAYED event and a second event id for the SAME invoice earn once", async () => {
    const a = await affiliate("replay");
    const b = await bringOn(a, "replay");
    const first = invoicePaid({ customerId: b.customerId });
    await applyAffiliateStripeEvent(first, T0);
    await applyAffiliateStripeEvent(first, T0);
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: b.customerId, invoiceId: invoiceIdOf(first) }),
      T0,
    );
    const rows = await rewardsOf(b.referredShopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rewardType).toBe("signup_credit");
  });

  it("🔴 the invoice key alone refuses a second credit for one invoice, whatever the code believes", async () => {
    const a = await affiliate("uniq");
    const b = await bringOn(a, "uniq");
    const inv = await pays(b, T0);
    const att = await runAsOwner((tx) =>
      tx.affiliateReferralAttribution.findUniqueOrThrow({
        where: { referredShopId: b.referredShopId },
        select: { id: true },
      }),
    );
    // A monthly credit (so the bring-on index is not what refuses it) for the
    // invoice that already earned the sign-up credit.
    await expect(
      runAsOwner((tx) =>
        tx.affiliateReward.create({
          data: {
            affiliateAccountId: a.accountId,
            referredShopId: b.referredShopId,
            attributionId: att.id,
            stripeInvoiceId: inv,
            rewardType: "monthly_credit",
            amountCents: MONTHLY,
            currency: "usd",
            basisPlan: "pro",
            qualifiedAt: new Date(T0),
            holdEndsAt: new Date(T0),
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await rewardsOf(b.referredShopId)).toHaveLength(1);
  });

  it("🔴 the same invoice redelivered AFTER later ones never earns again, and out-of-order delivery still totals one sign-up + monthly", async () => {
    const a = await affiliate("order");
    const b = await bringOn(a, "order");
    const jan = invoicePaid({ customerId: b.customerId, paidAtMs: T0 });
    const feb = invoicePaid({ customerId: b.customerId, paidAtMs: T0 + 30 * DAY });
    // February's invoice reaches us first, then January's, then February again.
    await applyAffiliateStripeEvent(feb, T0 + 30 * DAY);
    await applyAffiliateStripeEvent(jan, T0 + 30 * DAY);
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: b.customerId, invoiceId: invoiceIdOf(feb) }),
      T0 + 31 * DAY,
    );
    const rows = await rewardsOf(b.referredShopId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.rewardType === "signup_credit")).toHaveLength(1);
    expect(rows.reduce((n, r) => n + r.amountCents, 0)).toBe(SIGNUP + MONTHLY);
    expect(new Set(rows.map((r) => r.stripeInvoiceId))).toEqual(
      new Set([invoiceIdOf(jan), invoiceIdOf(feb)]),
    );
  });

  it("two DIFFERENT invoices arriving together: one sign-up credit, one monthly - never two sign-ups", async () => {
    const a = await affiliate("pair");
    const b = await bringOn(a, "pair");
    await Promise.all([
      applyAffiliateStripeEvent(invoicePaid({ customerId: b.customerId }), T0),
      applyAffiliateStripeEvent(invoicePaid({ customerId: b.customerId }), T0),
    ]);
    const rows = await rewardsOf(b.referredShopId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.rewardType).sort()).toEqual(["monthly_credit", "signup_credit"]);
  });

  it("a business that stops paying stops earning: a failed or cancelled month earns nothing", async () => {
    const a = await affiliate("stops");
    const b = await bringOn(a, "stops");
    await pays(b, T0);
    await pays(b, T0 + 30 * DAY);
    // Then the card fails and the subscription is cancelled. Neither is money.
    for (const type of ["invoice.payment_failed", "customer.subscription.deleted"]) {
      await applyAffiliateStripeEvent(
        {
          id: `evt_${randomToken(8)}`,
          type,
          data: { object: { id: `in_${randomToken(8)}`, customer: b.customerId, amount_paid: 0 } },
        },
        T0 + 60 * DAY,
      );
    }
    const rows = await rewardsOf(b.referredShopId);
    expect(rows.map((r) => r.rewardType)).toEqual(["signup_credit", "monthly_credit"]);
  });

  it("a suspended affiliate's credit is held for REVIEW, never dropped", async () => {
    const a = await affiliate("susp", { status: "SUSPENDED" });
    const b = await bringOn(a, "susp");
    await pays(b, T0);
    await pays(b, T0 + 30 * DAY);
    const rows = await rewardsOf(b.referredShopId);
    expect(rows.map((r) => r.status)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
  });

  it("🔴 with the flags off, a paid invoice earns NOTHING", async () => {
    const a = await affiliate("dark");
    const b = await bringOn(a, "dark");
    flags({ qualification: false });
    await pays(b, T0);
    await pays(b, T0 + 30 * DAY);
    expect(await rewardsOf(b.referredShopId)).toHaveLength(0);
  });
});

describe("dollar credit: refunds and disputes", () => {
  it("a refund reverses THAT invoice's credit, with reason and audit - and no other", async () => {
    const a = await affiliate("refund");
    const b = await bringOn(a, "refund");
    const jan = await pays(b, T0);
    const feb = await pays(b, T0 + 30 * DAY);
    await refund(feb, "charge.refunded", T0 + 31 * DAY);

    expect(await rewardForInvoice(feb)).toMatchObject({
      status: "REVERSED",
      reversalReason: "invoice_refunded",
    });
    expect((await rewardForInvoice(feb))!.reversedAt!.getTime()).toBe(T0 + 31 * DAY);
    expect((await rewardForInvoice(jan))!.status).toBe("PENDING");
    expect(await audit(b.referredShopId, "reward.reversed")).toHaveLength(1);
  });

  it("a dispute reverses the sign-up credit with its own classification; later months still earn monthly credit", async () => {
    const a = await affiliate("dispute");
    const b = await bringOn(a, "dispute");
    const jan = await pays(b, T0);
    await refund(jan, "charge.dispute.created");
    expect(await rewardForInvoice(jan)).toMatchObject({
      status: "REVERSED",
      reversalReason: "payment_disputed",
    });
    // The business was brought on once; the reversed sign-up credit is not
    // re-earned by the next month, which earns its own monthly credit.
    const feb = await pays(b, T0 + 30 * DAY);
    expect(await rewardForInvoice(feb)).toMatchObject({
      rewardType: "monthly_credit",
      amountCents: MONTHLY,
      status: "PENDING",
    });
  });

  it("a credit note reverses too; an already-APPLIED credit is not reversed this way", async () => {
    const a = await affiliate("cnote");
    const b = await bringOn(a, "cnote");
    const jan = await pays(b, T0);
    const feb = await pays(b, T0 + 30 * DAY);
    await runAsOwner((tx) =>
      tx.affiliateReward.update({ where: { stripeInvoiceId: jan }, data: { status: "APPLIED" } }),
    );
    await refund(jan, "credit_note.created");
    await refund(feb, "credit_note.created");
    expect((await rewardForInvoice(jan))!.status).toBe("APPLIED");
    expect(await rewardForInvoice(feb)).toMatchObject({ status: "REVERSED", reversalReason: "credit_note" });
  });
});

describe("dollar credit: the hold and no expiry", () => {
  it("releases after the hold with NO expiry date; the expiry job never touches it", async () => {
    const at = Date.UTC(2025, 6, 1, 12);
    const a = await affiliate("hold");
    const b = await bringOn(a, "hold");
    const inv = await pays(b, at);

    await releaseAffiliateRewardHolds({ nowMs: at + DAY });
    expect((await rewardForInvoice(inv))!.status).toBe("PENDING");

    await releaseAffiliateRewardHolds({ nowMs: at + HOLD_MS + DAY });
    const r = await rewardForInvoice(inv);
    expect(r!.status).toBe("AVAILABLE");
    expect(r!.availableAt!.getTime()).toBe(at + HOLD_MS + DAY);
    expect(r!.expiresAt).toBeNull();

    // Three years on, still not expired.
    await expireAffiliateRewards({ now: new Date(at + 3 * 365 * DAY) });
    expect((await rewardForInvoice(inv))!.status).toBe("AVAILABLE");
    // Tidy: take it out of circulation so a later reserve pass in this file
    // (or another suite) does not pick it up.
    await runAsOwner((tx) =>
      tx.affiliateReward.update({ where: { stripeInvoiceId: inv }, data: { status: "REVERSED", reversedAt: new Date(at), reversalReason: "admin_adjustment" } }),
    );
  });
});

describe("reward style: one choice, forward only", () => {
  it("the month-off style keeps v1 exactly: nothing on the first invoice, one month off on the second, nothing after", async () => {
    const a = await affiliate("monthoff", { style: "month_off" });
    const b = await bringOn(a, "monthoff");
    await pays(b, T0);
    expect(await rewardsOf(b.referredShopId)).toHaveLength(0);
    await pays(b, T0 + 30 * DAY);
    await pays(b, T0 + 60 * DAY);
    const rows = await rewardsOf(b.referredShopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rewardType: "subscription_credit", stripeInvoiceId: null });
  });

  it("🔴 switching style changes only what is earned AFTERWARDS; earned rewards keep their style", async () => {
    const a = await affiliate("switch");
    const first = await bringOn(a, "switch1");
    const jan = await pays(first, T0);
    expect((await rewardForInvoice(jan))!.rewardType).toBe("signup_credit");

    const switched = await setAffiliateRewardStyle({
      shopId: a.affiliateShopId,
      userId: a.ownerUserId,
      style: "month_off",
    });
    expect(switched.ok).toBe(true);

    // The credit already earned is untouched.
    expect(await rewardForInvoice(jan)).toMatchObject({
      rewardType: "signup_credit",
      amountCents: SIGNUP,
      status: "PENDING",
    });
    // The business already brought on earns no month off on top, and no more
    // monthly credit now the style is month off.
    await pays(first, T0 + 30 * DAY);
    expect((await rewardsOf(first.referredShopId)).map((r) => r.rewardType)).toEqual([
      "signup_credit",
    ]);
    // A business brought on after the switch earns a month off.
    const second = await bringOn(a, "switch2");
    await pays(second, T0 + 30 * DAY);
    await pays(second, T0 + 60 * DAY);
    expect((await rewardsOf(second.referredShopId)).map((r) => r.rewardType)).toEqual([
      "subscription_credit",
    ]);

    // And back again: future invoices earn dollar credit once more.
    await setAffiliateRewardStyle({ shopId: a.affiliateShopId, userId: a.ownerUserId, style: "dollar_credit" });
    const mar = await pays(first, T0 + 60 * DAY);
    expect(await rewardForInvoice(mar)).toMatchObject({ rewardType: "monthly_credit", amountCents: MONTHLY });
    expect((await rewardsOf(second.referredShopId)).map((r) => r.rewardType)).toEqual([
      "subscription_credit",
    ]);
  });
});

describe("dollar credit: execution through the credit operation", () => {
  async function availableCredit(a: Affiliate, label: string): Promise<{ signupId: string; monthlyId: string }> {
    const b = await bringOn(a, label);
    const jan = await pays(b, T0);
    const feb = await pays(b, T0 + 30 * DAY);
    await runAsOwner((tx) =>
      tx.affiliateReward.updateMany({
        where: { stripeInvoiceId: { in: [jan, feb] } },
        data: { status: "AVAILABLE", availableAt: new Date(T0) },
      }),
    );
    return {
      signupId: (await rewardForInvoice(jan))!.id,
      monthlyId: (await rewardForInvoice(feb))!.id,
    };
  }

  it("🔴 applies EXACTLY the reward's cents with the stable key, and never reads the plan price", async () => {
    const a = await affiliate("exec");
    const { signupId, monthlyId } = await availableCredit(a, "exec");
    // The affiliate's plan is cheaper than nothing in particular - a month
    // off would be capped by it; a dollar credit must not be.
    retrieve.mockResolvedValue({ items: { data: [{ price: { unit_amount: 1 } }] } });

    await reserveAffiliateCredits({ now: new Date(T0) });
    await executeAffiliateCredits({ now: new Date(T0), batch: 100 });

    const mine = createBalanceTransaction.mock.calls.filter((c) => c[0] === a.affiliateCustomerId);
    expect(mine).toHaveLength(2);
    const byKey = Object.fromEntries(
      mine.map(([, body, opts]) => [(opts as { idempotencyKey: string }).idempotencyKey, body]),
    );
    expect(byKey[`affiliate-reward:${signupId}`]).toMatchObject({ amount: -SIGNUP, currency: "usd" });
    expect(byKey[`affiliate-reward:${monthlyId}`]).toMatchObject({ amount: -MONTHLY, currency: "usd" });
    expect(retrieve).not.toHaveBeenCalled();

    const ops = await runAsOwner((tx) =>
      tx.affiliateCreditOperation.findMany({ where: { rewardId: { in: [signupId, monthlyId] } } }),
    );
    expect(ops.map((o) => o.status)).toEqual(["APPLIED", "APPLIED"]);
    expect(ops.map((o) => o.appliedCents).sort((x, y) => x! - y!)).toEqual([MONTHLY, SIGNUP]);
    const statuses = await runAsOwner((tx) =>
      tx.affiliateReward.findMany({ where: { id: { in: [signupId, monthlyId] } }, select: { status: true } }),
    );
    expect(statuses.map((s) => s.status)).toEqual(["APPLIED", "APPLIED"]);

    // A second pass applies nothing more.
    createBalanceTransaction.mockClear();
    await reserveAffiliateCredits({ now: new Date(T0) });
    await executeAffiliateCredits({ now: new Date(T0), batch: 100 });
    expect(createBalanceTransaction.mock.calls.filter((c) => c[0] === a.affiliateCustomerId)).toHaveLength(0);
  });

  it("🔴 an affiliate with no subscription is DEFERRED: the credit waits, unexpired, and lands once they pay", async () => {
    const a = await affiliate("deferred", { paying: false });
    const { signupId } = await availableCredit(a, "deferred");

    await reserveAffiliateCredits({ now: new Date(T0) });
    const first = await executeAffiliateCredits({ now: new Date(T0), batch: 100 });
    expect(first.deferred).toBeGreaterThanOrEqual(1);
    const op = await runAsOwner((tx) =>
      tx.affiliateCreditOperation.findUniqueOrThrow({ where: { rewardId: signupId } }),
    );
    expect(op.status).toBe("PENDING");
    expect(op.lastError).toBe("not_paying");
    expect(createBalanceTransaction).not.toHaveBeenCalled();

    // A year later, still waiting - nothing expired it.
    await expireAffiliateRewards({ now: new Date(T0 + 365 * DAY) });
    expect(
      (await runAsOwner((tx) => tx.affiliateReward.findUniqueOrThrow({ where: { id: signupId } }))).status,
    ).toBe("RESERVED");

    // They subscribe; the next pass applies it, exactly.
    const customerId = `cus_${randomToken(8)}`;
    await prisma.shop.update({
      where: { id: a.affiliateShopId },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: `sub_${randomToken(8)}`,
        subscriptionStatus: "active",
      },
    });
    await executeAffiliateCredits({ now: new Date(T0 + 366 * DAY), batch: 100 });
    const landed = createBalanceTransaction.mock.calls.filter((c) => c[0] === customerId);
    expect(landed.length).toBeGreaterThanOrEqual(1);
    const signupCall = landed.find(
      ([, , opts]) => (opts as { idempotencyKey: string }).idempotencyKey === `affiliate-reward:${signupId}`,
    );
    expect(signupCall?.[1]).toMatchObject({ amount: -SIGNUP });
  });

  it("with execution off it is a dry run: nothing reserved, Stripe never called", async () => {
    const a = await affiliate("execoff");
    const { signupId } = await availableCredit(a, "execoff");
    flags({ execution: false });
    const { runAffiliateCreditExecution } = await import("../engines/affiliateCredit.js");
    const r = await runAffiliateCreditExecution({ now: new Date(T0) });
    expect(r.dryRun).toBe(true);
    expect(
      (await runAsOwner((tx) => tx.affiliateReward.findUniqueOrThrow({ where: { id: signupId } }))).status,
    ).toBe("AVAILABLE");
    expect(createBalanceTransaction).not.toHaveBeenCalled();
    // Leave nothing AVAILABLE behind for other suites' reserve passes.
    await runAsOwner((tx) =>
      tx.affiliateReward.updateMany({
        where: { affiliateAccountId: a.accountId, status: "AVAILABLE" },
        data: { status: "REVERSED", reversedAt: new Date(T0), reversalReason: "admin_adjustment" },
      }),
    );
  });
});
