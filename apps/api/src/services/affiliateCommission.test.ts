import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  commissionWindowEnd,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { applyAffiliateStripeEvent } from "./affiliateQualification.js";
import {
  commissionsEnabled,
  earnCommissionForInvoice,
  getAffiliateEarnings,
  releaseAffiliateCommissionHolds,
} from "./affiliateCommission.js";
import { holdTableLock, raceBehindBarrier } from "../testing/raceBarrier.js";

/**
 * The v2 commission LEDGER: one line per paid base-plan invoice in a referred
 * business's first 12 months, held 30 days, released only after the business
 * has paid twice. Nothing here moves money - every assertion is about rows.
 *
 * 🔴 RETIRED FOR EARNING (2026-10-30). The owner replaced percentage
 * commissions with dollar ACCOUNT CREDIT (affiliateQualification.ts,
 * AFFILIATE_POLICY.dollarCredit) before the ledger was ever switched on, so
 * the Stripe webhook no longer writes commission lines - the first test pins
 * that. The ledger's own rules (one line per invoice, the window, the hold,
 * reversal and clawback) are still exercised here by calling
 * earnCommissionForInvoice directly, because its reversal path, sweep and
 * read model still run against any line that exists.
 *
 * Same Stripe realities as the qualification suite: events are redelivered,
 * reordered, and sometimes two event ids describe one invoice. The INVOICE is
 * the earning key, a unique index is the guard.
 */

const BASE_PRICE = "price_base_commission_test";
const ADDON_PRICE = "price_addon_commission_test";
const DAY = 86_400_000;
const HOLD = AFFILIATE_POLICY.commission.holdDays * DAY;

const emails: string[] = [];
const shopIds: string[] = [];

function flags(opts: { qualification?: boolean; commissions?: boolean } = {}) {
  const q = opts.qualification ?? true;
  process.env.AFFILIATE_PROGRAM_ENABLED = q ? "true" : "false";
  process.env.AFFILIATE_QUALIFICATION_ENABLED = q ? "true" : "false";
  process.env.AFFILIATE_COMMISSIONS_ENABLED = (opts.commissions ?? true) ? "true" : "false";
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

async function makeShop(ownerId: string, over: Record<string, unknown> = {}): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: `C ${randomToken(4)}`,
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
      ...over,
    },
  });
  shopIds.push(shop.id);
  return shop.id;
}

interface Scenario {
  accountId: string;
  referredShopId: string;
  customerId: string;
}

/** An approved affiliate and a referred shop attributed to it. */
async function scenario(
  label: string,
  opts: { payoutPreference?: "cash" | "credit"; accountStatus?: string } = {},
): Promise<Scenario> {
  const referrerOwner = await makeUser(`${label}-ref`);
  const referrerShopId = await makeShop(referrerOwner, { plan: "pro" });
  const referredOwner = await makeUser(`${label}-friend`);
  const customerId = `cus_${randomToken(8)}`;
  const referredShopId = await makeShop(referredOwner, { stripeCustomerId: customerId });

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
        ...(opts.payoutPreference
          ? { payoutPreference: opts.payoutPreference, payoutPreferenceSetAt: new Date() }
          : {}),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: AFFILIATE_POLICY_VERSION,
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
  paidAtMs: number;
  eventId?: string;
  invoiceId?: string;
  priceId?: string;
  amount?: number;
  taxCents?: number;
  /** Override amount_paid (a coupon or a customer-balance credit). */
  amountPaid?: number;
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
        amount_paid: opts.amountPaid ?? amount + (opts.taxCents ?? 0),
        tax: opts.taxCents ?? 0,
        status_transitions: { paid_at: Math.floor(opts.paidAtMs / 1000) },
        lines: { data: [{ amount, price: { id: opts.priceId ?? BASE_PRICE } }] },
      },
    },
  };
}

function invoiceIdOf(event: ReturnType<typeof invoicePaid>): string {
  return (event.data.object as { id: string }).id;
}

/**
 * Earn a commission line for an invoice exactly as the retired webhook branch
 * did: only for an invoice the qualification path accepted (it records an
 * AffiliateQualifyingInvoice row - which it refuses for flags off, add-on-only
 * and zero-paid invoices), on the base amount actually paid net of tax.
 */
async function earnLikeTheRetiredBranch(event: ReturnType<typeof invoicePaid>, s: Scenario) {
  if (!commissionsEnabled()) return;
  const inv = event.data.object as {
    id: string;
    amount_paid: number;
    tax: number;
    status_transitions: { paid_at: number };
    lines: { data: { amount: number; price: { id: string } }[] };
  };
  const recorded = await runAsOwner((tx) =>
    tx.affiliateQualifyingInvoice.findUnique({ where: { stripeInvoiceId: inv.id } }),
  );
  if (!recorded) return;
  const base = inv.lines.data
    .filter((l) => l.price.id === BASE_PRICE)
    .reduce((n, l) => n + l.amount, 0);
  await runAsOwner((tx) =>
    earnCommissionForInvoice(tx, {
      stripeInvoiceId: inv.id,
      referredShopId: s.referredShopId,
      affiliateAccountId: s.accountId,
      basisCents: Math.min(base, inv.amount_paid - inv.tax),
      currency: "usd",
      paidAt: new Date(inv.status_transitions.paid_at * 1000),
    }),
  );
}

/** Deliver an invoice.paid, earn its line, and return its invoice id. */
async function pay(
  s: Scenario,
  paidAtMs: number,
  over: Partial<Parameters<typeof invoicePaid>[0]> = {},
): Promise<string> {
  const event = invoicePaid({ customerId: s.customerId, paidAtMs, ...over });
  await applyAffiliateStripeEvent(event, paidAtMs);
  await earnLikeTheRetiredBranch(event, s);
  return invoiceIdOf(event);
}

function linesFor(referredShopId: string) {
  return runAsOwner((tx) =>
    tx.affiliateCommission.findMany({
      where: { referredShopId },
      orderBy: { earnedAt: "asc" },
    }),
  );
}

function lineFor(stripeInvoiceId: string) {
  return runAsOwner((tx) => tx.affiliateCommission.findUnique({ where: { stripeInvoiceId } }));
}

function eventsOf(referredShopId: string, type: string) {
  return runAsOwner((tx) =>
    tx.affiliateAuditEvent.findMany({ where: { shopId: referredShopId, type } }),
  );
}

async function refund(invoiceId: string, type = "charge.refunded", nowMs?: number) {
  await applyAffiliateStripeEvent(
    {
      id: `evt_${randomToken(8)}`,
      type,
      data: { object: { invoice: invoiceId } },
    },
    nowMs,
  );
}

/** Stand-in for the payout phase (PR 2): mark a line paid out. */
async function markPaid(invoiceId: string) {
  await runAsOwner((tx) =>
    tx.affiliateCommission.update({
      where: { stripeInvoiceId: invoiceId },
      data: { status: "PAID", availableAt: new Date(), payoutId: `po_${randomToken(6)}` },
    }),
  );
}

// Each test uses its own era so a sweep in one never depends on another's rows.
const T0 = Date.UTC(2026, 0, 15, 12);

beforeAll(() => flags());

afterEach(() => flags());

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_QUALIFICATION_ENABLED;
  delete process.env.AFFILIATE_COMMISSIONS_ENABLED;
  delete process.env.STRIPE_PRICE_ID;
  __resetEnvCacheForTests();
  const ids = shopIds.filter(Boolean);
  if (ids.length > 0) {
    await runAsOwner(async (tx) => {
      await tx.affiliateCommission.deleteMany({ where: { referredShopId: { in: ids } } });
      await tx.affiliateReward.deleteMany({ where: { referredShopId: { in: ids } } });
      await tx.affiliateQualifyingInvoice.deleteMany({ where: { referredShopId: { in: ids } } });
      await tx.affiliateReferralAttribution.deleteMany({ where: { referredShopId: { in: ids } } });
      await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: ids } } });
    });
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await runAsOwner(async (tx) => {
        const shops = await tx.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
        const sids = shops.map((s) => s.id);
        await tx.affiliateAccount.deleteMany({ where: { shopId: { in: sids } } });
        await tx.affiliateApplication.deleteMany({ where: { shopId: { in: sids } } });
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("commissions: retired for earning", () => {
  it("🔴 even with AFFILIATE_COMMISSIONS_ENABLED on, a paid invoice writes NO commission line - it earns dollar credit instead", async () => {
    flags({ commissions: true });
    const s = await scenario("retired");
    await applyAffiliateStripeEvent(invoicePaid({ customerId: s.customerId, paidAtMs: T0 }), T0);
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, paidAtMs: T0 + 31 * DAY }),
      T0 + 31 * DAY,
    );

    expect(await linesFor(s.referredShopId)).toHaveLength(0);
    const rewards = await runAsOwner((tx) =>
      tx.affiliateReward.findMany({
        where: { referredShopId: s.referredShopId },
        orderBy: { qualifiedAt: "asc" },
      }),
    );
    expect(rewards.map((r) => r.rewardType)).toEqual(["signup_credit", "monthly_credit"]);
  });

  it("with the qualification flags off, the commission flag alone earns nothing", async () => {
    flags({ qualification: false, commissions: true });
    const s = await scenario("qualoff");
    await pay(s, T0);
    expect(await linesFor(s.referredShopId)).toHaveLength(0);
  });
});

describe("commissions: earning", () => {
  it("one HELD line per distinct base invoice, held 30 days from paid_at", async () => {
    const s = await scenario("earn");
    const a = await pay(s, T0);
    const b = await pay(s, T0 + 31 * DAY);
    const c = await pay(s, T0 + 59 * DAY);

    const lines = await linesFor(s.referredShopId);
    expect(lines.map((l) => l.stripeInvoiceId)).toEqual([a, b, c]);
    for (const l of lines) {
      expect(l.status).toBe("HELD");
      expect(l.affiliateAccountId).toBe(s.accountId);
      expect(l.holdEndsAt.getTime() - l.earnedAt.getTime()).toBe(HOLD);
      expect(l.availableAt).toBeNull();
    }
    expect(lines[0]!.earnedAt.getTime()).toBe(T0);
    expect(await eventsOf(s.referredShopId, "commission.earned")).toHaveLength(3);
  });

  it("🔴 a REPLAYED event, and a second event id for the SAME invoice, earn once", async () => {
    const s = await scenario("replay");
    const first = invoicePaid({ customerId: s.customerId, paidAtMs: T0 });
    await applyAffiliateStripeEvent(first, T0);
    await earnLikeTheRetiredBranch(first, s);
    await applyAffiliateStripeEvent(first, T0);
    await earnLikeTheRetiredBranch(first, s);
    const again = invoicePaid({ customerId: s.customerId, paidAtMs: T0, invoiceId: invoiceIdOf(first) });
    await applyAffiliateStripeEvent(again, T0);
    await earnLikeTheRetiredBranch(again, s);
    expect(await linesFor(s.referredShopId)).toHaveLength(1);
    expect(await eventsOf(s.referredShopId, "commission.earned")).toHaveLength(1);
  });

  it("🔴 the unique index refuses a second line for one invoice, whatever the code believes", async () => {
    const s = await scenario("uniq");
    const invoiceId = await pay(s, T0);
    await expect(
      runAsOwner((tx) =>
        tx.affiliateCommission.create({
          data: {
            affiliateAccountId: s.accountId,
            referredShopId: s.referredShopId,
            stripeInvoiceId: invoiceId,
            baseAmountCents: 3499,
            rateBps: 3000,
            amountCents: 1049,
            currency: "usd",
            kind: "credit",
            earnedAt: new Date(T0),
            holdEndsAt: new Date(T0 + HOLD),
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await linesFor(s.referredShopId)).toHaveLength(1);
  });

  it("🔴 two CONCURRENT earns for the same invoice create one line", async () => {
    const s = await scenario("race");
    const invoiceId = `in_${randomToken(8)}`;
    // The qualification path records the invoice first (as it did when it
    // called the ledger); then two earns race on the ledger itself.
    await applyAffiliateStripeEvent(
      invoicePaid({ customerId: s.customerId, paidAtMs: T0, invoiceId }),
      T0,
    );
    const earn = () =>
      runAsOwner((tx) =>
        earnCommissionForInvoice(tx, {
          stripeInvoiceId: invoiceId,
          referredShopId: s.referredShopId,
          affiliateAccountId: s.accountId,
          basisCents: 3499,
          currency: "usd",
          paidAt: new Date(T0),
        }),
      );
    // Hold the ledger table: both earns must get as far as the commission
    // write and STOP. Only then is the one-line-per-invoice guard contended.
    const barrier = await holdTableLock("AffiliateCommission");
    const { settledEarly } = await raceBehindBarrier(barrier, [earn, earn]);
    expect(settledEarly).toBe(0);
    expect(await linesFor(s.referredShopId)).toHaveLength(1);
    expect(await eventsOf(s.referredShopId, "commission.earned")).toHaveLength(1);
  });

  it("credit earns 30% and cash 20%, FROZEN at earn time - changing the preference never rewrites old lines", async () => {
    const s = await scenario("rates"); // default preference: credit
    const a = await pay(s, T0, { amount: 3499 });
    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: s.accountId },
        data: { payoutPreference: "cash", payoutPreferenceSetAt: new Date() },
      }),
    );
    const b = await pay(s, T0 + 31 * DAY, { amount: 3499 });

    const first = await lineFor(a);
    expect(first).toMatchObject({
      kind: "credit",
      rateBps: 3000,
      baseAmountCents: 3499,
      amountCents: 1049, // 1049.7 rounded DOWN
    });
    const second = await lineFor(b);
    expect(second).toMatchObject({
      kind: "cash",
      rateBps: 2000,
      baseAmountCents: 3499,
      amountCents: 699, // 699.8 rounded DOWN
    });
  });

  it("tax, add-on-only and zero-paid invoices earn nothing; a coupon caps the basis at what was paid", async () => {
    const s = await scenario("excl", { payoutPreference: "cash" });
    await pay(s, T0, { priceId: ADDON_PRICE });
    await pay(s, T0 + DAY, { amountPaid: 0 });
    expect(await linesFor(s.referredShopId)).toHaveLength(0);

    // Tax rides on top and is never commissioned.
    const taxed = await pay(s, T0 + 2 * DAY, { amount: 3499, taxCents: 900 });
    expect((await lineFor(taxed))?.baseAmountCents).toBe(3499);

    // A 50% coupon: the base line says 3499, the business paid 1750 (+ tax).
    const discounted = await pay(s, T0 + 33 * DAY, {
      amount: 3499,
      taxCents: 100,
      amountPaid: 1750 + 100,
    });
    expect(await lineFor(discounted)).toMatchObject({ baseAmountCents: 1750, amountCents: 350 });
  });

  it("🔴 only invoices paid in the first 12 months earn: the boundary instant itself does not", async () => {
    const s = await scenario("window");
    const first = Date.UTC(2026, 0, 31, 9); // Jan 31 - the month-end edge
    const end = commissionWindowEnd(new Date(first)).getTime();
    expect(new Date(end).toISOString()).toBe("2027-01-31T09:00:00.000Z");

    await pay(s, first);
    const lastIn = await pay(s, end - 1000);
    const onBoundary = await pay(s, end);
    const after = await pay(s, end + 30 * DAY);

    expect(await lineFor(lastIn)).not.toBeNull();
    expect(await lineFor(onBoundary)).toBeNull();
    expect(await lineFor(after)).toBeNull();
    expect(await linesFor(s.referredShopId)).toHaveLength(2);
  });

  it("a suspended affiliate's line is REVIEW_REQUIRED and audited, never dropped", async () => {
    const s = await scenario("susp", { accountStatus: "SUSPENDED" });
    const id = await pay(s, T0);
    expect((await lineFor(id))?.status).toBe("REVIEW_REQUIRED");
    expect(await eventsOf(s.referredShopId, "commission.review_flagged")).toHaveLength(1);
    expect(await eventsOf(s.referredShopId, "commission.earned")).toHaveLength(0);
  });
});

describe("commissions: refunds, disputes and credit notes", () => {
  it("a refund before payout REVERSES the line, with reason and audit", async () => {
    const s = await scenario("refund");
    await pay(s, T0);
    const b = await pay(s, T0 + 31 * DAY);
    await refund(b, "charge.refunded", T0 + 32 * DAY);

    const line = await lineFor(b);
    expect(line?.status).toBe("REVERSED");
    expect(line?.reversalReason).toBe("invoice_refunded");
    expect(line?.reversedAt?.getTime()).toBe(T0 + 32 * DAY);
    expect(line?.clawbackDueAt).toBeNull();
    expect(await eventsOf(s.referredShopId, "commission.reversed")).toHaveLength(1);
  });

  it("a dispute reverses an AVAILABLE line, a credit note reverses a REVIEW_REQUIRED one", async () => {
    const s = await scenario("disp");
    const a = await pay(s, T0);
    await runAsOwner((tx) =>
      tx.affiliateCommission.update({
        where: { stripeInvoiceId: a },
        data: { status: "AVAILABLE", availableAt: new Date() },
      }),
    );
    await refund(a, "charge.dispute.created");
    expect(await lineFor(a)).toMatchObject({ status: "REVERSED", reversalReason: "payment_disputed" });

    const susp = await scenario("cnote", { accountStatus: "SUSPENDED" });
    const c = await pay(susp, T0);
    await refund(c, "credit_note.created");
    expect(await lineFor(c)).toMatchObject({ status: "REVERSED", reversalReason: "credit_note" });
  });

  it("🔴 after PAID: status stays PAID, clawbackDueAt is set once, and nothing is reversed", async () => {
    const s = await scenario("clawback");
    const a = await pay(s, T0);
    await markPaid(a);

    await refund(a, "charge.refunded", T0 + 90 * DAY);
    const line = await lineFor(a);
    expect(line?.status).toBe("PAID");
    expect(line?.clawbackDueAt?.getTime()).toBe(T0 + 90 * DAY);
    expect(line?.reversalReason).toBe("invoice_refunded");
    expect(line?.reversedAt).toBeNull();

    // A later dispute on the same invoice changes nothing: the first wins.
    await refund(a, "charge.dispute.created", T0 + 95 * DAY);
    const again = await lineFor(a);
    expect(again?.clawbackDueAt?.getTime()).toBe(T0 + 90 * DAY);
    expect(again?.reversalReason).toBe("invoice_refunded");
    expect(await eventsOf(s.referredShopId, "commission.clawback_due")).toHaveLength(1);
    expect(await eventsOf(s.referredShopId, "commission.reversed")).toHaveLength(0);
  });

  it("a refund still reverses a line after the commission flag is switched off", async () => {
    const s = await scenario("offrefund");
    const a = await pay(s, T0);
    flags({ commissions: false });
    await refund(a);
    expect((await lineFor(a))?.status).toBe("REVERSED");
  });
});

describe("commissions: the hold sweep", () => {
  it("🔴 releases nothing before 30 days, nothing with only ONE paid invoice, and AVAILABLE after both", async () => {
    const T = Date.UTC(2027, 5, 1, 12);
    const s = await scenario("sweep");
    const a = await pay(s, T);

    // Hold not over.
    await releaseAffiliateCommissionHolds({ nowMs: T + HOLD - DAY });
    expect((await lineFor(a))?.status).toBe("HELD");

    // Hold over, but only one invoice paid: still HELD.
    await releaseAffiliateCommissionHolds({ nowMs: T + HOLD + DAY });
    expect((await lineFor(a))?.status).toBe("HELD");

    // The second invoice arrives; the first line is now releasable, the
    // second is still in its own hold.
    const b = await pay(s, T + HOLD + 2 * DAY);
    const sweepAt = T + HOLD + 3 * DAY;
    const result = await releaseAffiliateCommissionHolds({ nowMs: sweepAt });
    expect(result.dryRun).toBe(false);
    expect(result.released).toBeGreaterThanOrEqual(1);

    const first = await lineFor(a);
    expect(first?.status).toBe("AVAILABLE");
    expect(first?.availableAt?.getTime()).toBe(sweepAt);
    expect((await lineFor(b))?.status).toBe("HELD");
    expect(await eventsOf(s.referredShopId, "commission.available")).toHaveLength(1);
  });

  it("is a DRY RUN while the flag is off: it reports what it would release and writes nothing", async () => {
    const T = Date.UTC(2027, 8, 1, 12);
    const s = await scenario("dry");
    const a = await pay(s, T);
    await pay(s, T + 31 * DAY);

    flags({ commissions: false });
    const result = await releaseAffiliateCommissionHolds({ nowMs: T + HOLD + DAY });
    expect(result.dryRun).toBe(true);
    expect(result.eligible).toBeGreaterThanOrEqual(1);
    expect(result.released).toBe(0);
    expect((await lineFor(a))?.status).toBe("HELD");
    expect(await eventsOf(s.referredShopId, "commission.available")).toHaveLength(0);
  });

  it("a REFUNDED invoice does not count toward the two-invoice minimum", async () => {
    const T = Date.UTC(2027, 10, 1, 12);
    const s = await scenario("refcount");
    const a = await pay(s, T);
    const b = await pay(s, T + 31 * DAY);
    await refund(b);

    await releaseAffiliateCommissionHolds({ nowMs: T + HOLD + 2 * DAY });
    // Two invoices were paid, one came back: the business has paid once.
    expect((await lineFor(a))?.status).toBe("HELD");
  });

  it("a line whose affiliate was suspended after earning goes to REVIEW_REQUIRED, not AVAILABLE", async () => {
    const T = Date.UTC(2028, 1, 1, 12);
    const s = await scenario("latesusp");
    const a = await pay(s, T);
    await pay(s, T + 31 * DAY);
    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: s.accountId },
        data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "suspected_abuse" },
      }),
    );
    const result = await releaseAffiliateCommissionHolds({ nowMs: T + HOLD + DAY });
    expect(result.flagged).toBeGreaterThanOrEqual(1);
    const line = await lineFor(a);
    expect(line?.status).toBe("REVIEW_REQUIRED");
    expect(line?.availableAt).toBeNull();
  });
});

describe("commissions: the earnings read model", () => {
  it("totals cents by kind and status, and counts businesses still earning", async () => {
    const T = Date.UTC(2028, 4, 1, 12);
    const s = await scenario("totals", { payoutPreference: "cash" });
    const a = await pay(s, T, { amount: 10_000 }); // cash 2000
    await pay(s, T + 31 * DAY, { amount: 10_000 }); // cash 2000
    await releaseAffiliateCommissionHolds({ nowMs: T + HOLD + DAY }); // a -> AVAILABLE
    expect((await lineFor(a))?.status).toBe("AVAILABLE");

    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: s.accountId },
        data: { payoutPreference: "credit" },
      }),
    );
    const c = await pay(s, T + 62 * DAY, { amount: 10_000 }); // credit 3000
    await refund(c); // credit 3000 reversed

    // A second business for the same affiliate, all of it reversed.
    const otherOwner = await makeUser("totals-friend2");
    const otherCustomer = `cus_${randomToken(8)}`;
    const otherShop = await makeShop(otherOwner, { stripeCustomerId: otherCustomer });
    await runAsOwner((tx) =>
      tx.affiliateReferralAttribution.create({
        data: {
          referredShopId: otherShop,
          affiliateAccountId: s.accountId,
          codeUsed: "x",
          source: "link",
          state: "ATTRIBUTED",
          capturedAt: new Date(),
          lockedAt: new Date(),
          claimExpiresAt: new Date(Date.now() + DAY),
        },
      }),
    );
    const other = { ...s, referredShopId: otherShop, customerId: otherCustomer };
    const d = await pay(other, T, { amount: 5000 }); // credit 1500
    await refund(d);

    const e = await getAffiliateEarnings(s.accountId);
    expect(e.cash).toEqual({
      heldCents: 2000,
      availableCents: 2000,
      reviewCents: 0,
      paidCents: 0,
      reversedCents: 0,
      clawbackDueCents: 0,
    });
    expect(e.credit.reversedCents).toBe(4500);
    expect(e.credit.heldCents).toBe(0);
    expect(e.businessesEarning).toBe(1);
    expect(e.minimumCashPayoutCents).toBe(2500);
  });
});
