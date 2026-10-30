import { Prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_BRING_ON_REWARD_TYPES,
  AFFILIATE_POLICY,
  PLANS,
  apiEnv,
  dollarCreditCents,
  isDollarRewardType,
} from "@chairback/config";
import { logger } from "../logger.js";
import { recordAffiliateEvent } from "./affiliateAudit.js";
import { reverseCommissionForInvoice } from "./affiliateCommission.js";
import { enqueueAffiliateEmail } from "./affiliateNotify.js";

/**
 * Affiliate qualification: turning cleared money into a reward LEDGER ENTRY.
 *
 * 🔴 NOTHING HERE TALKS TO STRIPE. It only reads events Stripe already
 * delivered and writes our own rows. Reserving and applying a credit is the
 * credit-execution phase; a reversal here is a status transition and an audit
 * event, never a card charge.
 *
 * 🔴 IT CANNOT AFFECT LEGACY BILLING. The webhook route calls this AFTER
 * applyStripeEvent/applyPaymentEvent and swallows anything it throws, and this
 * module has its own dedupe table rather than gating the shared handler - so
 * legacy billing and the legacy referral grant keep their existing semantics
 * exactly, including their own replay behaviour.
 *
 * THE RULES (from AFFILIATE_POLICY, not invented here)
 *  - Only successful, non-zero, BASE-SUBSCRIPTION invoices count. A free
 *    trial pays nothing, so a bare signup never earns anything.
 *  - Distinct INVOICES, never webhook deliveries: Stripe redelivers for days
 *    and out of order, so the invoice id is the counting key.
 *  - The affiliate's REWARD STYLE when an invoice is paid decides what it
 *    earns, and is frozen onto the reward (a later switch never rewrites it):
 *      dollar_credit  every paid invoice earns one credit row, keyed by the
 *                     invoice id (UNIQUE). The business's first one earns
 *                     dollarCredit.signupCents, every later one
 *                     dollarCredit.monthlyCents, for as long as it pays.
 *      month_off      two paid invoices qualify ONE month off (v1, unchanged).
 *  - Every reward waits out the same 14-day hold before it is available.
 *  - One BRING-ON reward per referred shop, ever (the month off or the
 *    sign-up credit) - a partial unique index, not a check.
 *  - Past the rolling-year threshold a bring-on reward is HELD for review,
 *    never silently discarded.
 */

/** Stripe event shapes we read. Kept structural: the SDK's types differ by
 *  API version and we only ever touch these fields. */
interface StripeLikeEvent {
  id?: string;
  type?: string;
  // `unknown` rather than a record: Stripe's own Event union types
  // data.object as a specific resource per event type, and none of those
  // carry an index signature. Everything below narrows before it reads.
  data?: { object?: unknown };
}

/** Events this module reacts to at all. */
const HANDLED = new Set([
  "invoice.paid",
  "charge.refunded",
  "charge.dispute.created",
  "credit_note.created",
]);

export type ReversalReason =
  | "invoice_refunded"
  | "payment_disputed"
  | "credit_note"
  | "admin_adjustment";

function qualificationEnabled(): boolean {
  const env = apiEnv();
  return env.AFFILIATE_PROGRAM_ENABLED && env.AFFILIATE_QUALIFICATION_ENABLED;
}

/**
 * The price ids that count as the BASE subscription. The add-on price is
 * deliberately absent: the contract excludes add-ons, SMS, tax, fees and
 * one-time purchases from both qualification and the reward.
 *
 * Fails CLOSED: with no base price configured nothing qualifies, because the
 * alternative is guessing which line on an invoice was the subscription.
 */
function basePriceIds(): Set<string> {
  const env = apiEnv();
  return new Set(
    [env.STRIPE_PRICE_ID, env.STRIPE_PREMIUM_AI_PRICE_ID].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
  );
}

/**
 * Cents of BASE subscription on this invoice.
 *
 * Line `amount` in Stripe excludes tax (tax rides in `tax_amounts` and the
 * invoice-level `tax`), so summing base-plan lines is what "excludes tax,
 * add-ons, SMS and one-time charges" means in practice.
 */
function baseSubscriptionCents(invoice: Record<string, unknown>): number {
  const base = basePriceIds();
  if (base.size === 0) return 0;
  const lines = (invoice.lines as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(lines)) return 0;
  let cents = 0;
  for (const raw of lines) {
    const line = raw as { amount?: unknown; price?: { id?: unknown } };
    const priceId = line.price?.id;
    if (typeof priceId !== "string" || !base.has(priceId)) continue;
    if (typeof line.amount === "number" && line.amount > 0) cents += line.amount;
  }
  return cents;
}

/** The referrer's own base plan price at qualification, as a money snapshot. */
function rewardAmountCents(plan: string): { cents: number; basisPlan: string } | null {
  // The referrer's OWN plan decides the reward - a Premium AI referrer earns
  // their own month. Read from the plan table, never a literal in this file.
  const entry =
    plan === "pro_ai"
      ? PLANS.pro_ai
      : plan === "pro"
        ? PLANS.pro
        : plan === "starter"
          ? PLANS.starter
          : null;
  if (!entry || entry.priceMonthlyUsd <= 0) return null;
  return { cents: Math.round(entry.priceMonthlyUsd * 100), basisPlan: plan };
}

/**
 * Record that we have seen this Stripe event, exactly once.
 *
 * createMany + skipDuplicates rather than create + catch: a P2002 caught in
 * JavaScript does NOT un-abort the surrounding Postgres transaction. `count
 * === 0` IS the "already processed" signal.
 */
async function claimEvent(
  tx: Prisma.TransactionClient,
  eventId: string,
  type: string,
): Promise<boolean> {
  const { count } = await tx.stripeWebhookEvent.createMany({
    data: [{ eventId, type }],
    skipDuplicates: true,
  });
  return count > 0;
}

/**
 * The webhook entry point. Never throws: the caller is the billing webhook,
 * and an affiliate problem must not cost Stripe a delivery it would otherwise
 * consider handled.
 */
export async function applyAffiliateStripeEvent(
  event: StripeLikeEvent,
  nowMs?: number,
): Promise<void> {
  if (!qualificationEnabled()) return;
  const eventId = typeof event.id === "string" ? event.id : null;
  const type = typeof event.type === "string" ? event.type : null;
  if (!eventId || !type || !HANDLED.has(type)) return;
  const object = event.data?.object;
  if (!object || typeof object !== "object") return;

  try {
    await runAsOwner(async (tx) => {
      // Replay protection first: a redelivered event does nothing at all.
      if (!(await claimEvent(tx, eventId, type))) return;
      if (type === "invoice.paid") {
        await qualifyFromInvoice(tx, object as Record<string, unknown>, nowMs);
      } else {
        await reverseFromEvent(tx, type, object as Record<string, unknown>, nowMs);
      }
    });
  } catch (err) {
    // Classification only - a Stripe error object carries customer detail.
    logger.error(
      { eventId, type, errName: err instanceof Error ? err.name : "unknown" },
      "affiliate: qualification failed for a stripe event",
    );
  }
}

async function qualifyFromInvoice(
  tx: Prisma.TransactionClient,
  invoice: Record<string, unknown>,
  nowMs?: number,
): Promise<void> {
  const invoiceId = typeof invoice.id === "string" ? invoice.id : null;
  const amountPaid = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
  if (!invoiceId || amountPaid <= 0) return;

  const baseCents = baseSubscriptionCents(invoice);
  // Tax-only, add-on-only or one-time invoices carry no base subscription and
  // never move a referral toward qualification.
  if (baseCents <= 0) return;

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : ((invoice.customer as { id?: string } | undefined)?.id ?? null);
  if (!customerId) return;

  const referredShop = await tx.shop.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  if (!referredShop) return;

  const attribution = await tx.affiliateReferralAttribution.findUnique({
    where: { referredShopId: referredShop.id },
    select: { id: true, state: true, affiliateAccountId: true },
  });
  // No live attribution: nothing to qualify. A REJECTED row (including one the
  // legacy program superseded) is deliberately inert here - legacy pays it.
  if (!attribution || attribution.state !== "ATTRIBUTED") return;
  if (!attribution.affiliateAccountId) return;

  const nowDate = new Date(nowMs ?? Date.now());
  const paidAt =
    typeof invoice.status_transitions === "object" &&
    invoice.status_transitions !== null &&
    typeof (invoice.status_transitions as { paid_at?: unknown }).paid_at === "number"
      ? new Date(
          (invoice.status_transitions as { paid_at: number }).paid_at * 1000,
        )
      : nowDate;

  // Distinct invoices, not deliveries. A second webhook for the SAME invoice
  // adds nothing even if it slipped past the event dedupe (a different event
  // id for the same invoice, which Stripe does emit).
  await tx.affiliateQualifyingInvoice.createMany({
    data: [
      {
        referredShopId: referredShop.id,
        stripeInvoiceId: invoiceId,
        amountCents: baseCents,
        currency: typeof invoice.currency === "string" ? invoice.currency : "usd",
        paidAt,
      },
    ],
    skipDuplicates: true,
  });

  // 🔴 The v2 COMMISSION LEDGER (a percentage of each invoice) no longer
  // earns: the owner's 2026-10-30 decision replaced it with dollar ACCOUNT
  // CREDIT before it was ever switched on. Its reversal path below still
  // runs, so any line that exists is still taken back on a refund.

  const account = await tx.affiliateAccount.findUnique({
    where: { id: attribution.affiliateAccountId },
    select: {
      id: true,
      status: true,
      shopId: true,
      rewardStyle: true,
      shop: { select: { plan: true } },
    },
  });
  if (!account) return;

  if (account.rewardStyle === "dollar_credit") {
    await earnDollarCredit(tx, {
      invoiceId,
      referredShopId: referredShop.id,
      attributionId: attribution.id,
      account,
      now: nowDate,
    });
    return;
  }

  await qualifyMonthOff(tx, {
    referredShopId: referredShop.id,
    attributionId: attribution.id,
    account,
    now: nowDate,
  });
}

interface EarningAccount {
  id: string;
  status: string;
  shopId: string;
  shop: { plan: string };
}

/** Bring-on rewards this account earned in the last 365 days. Monthly
 *  credits never count: one business paying for a year is not twelve
 *  businesses. */
async function bringOnRewardsThisYear(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
): Promise<number> {
  return tx.affiliateReward.count({
    where: {
      affiliateAccountId: accountId,
      rewardType: { in: [...AFFILIATE_BRING_ON_REWARD_TYPES] },
      qualifiedAt: { gte: new Date(now.getTime() - 365 * 86_400_000) },
    },
  });
}

function holdEnd(now: Date): Date {
  return new Date(
    now.getTime() + AFFILIATE_POLICY.qualification.holdDaysAfterSecond * 86_400_000,
  );
}

/**
 * DOLLAR CREDIT: this paid invoice earns exactly one credit row.
 *
 * Which one? If the business has no bring-on reward yet, this invoice brings
 * it on (signup_credit); otherwise it is another paid month
 * (monthly_credit). Two unique indexes make that safe under Stripe's
 * redeliveries and reorderings, with no lock:
 *
 *  - stripeInvoiceId UNIQUE: the same invoice never earns twice, however many
 *    event ids describe it.
 *  - one bring-on per referred shop (partial UNIQUE): when two DIFFERENT
 *    invoices race to be the first, one wins the sign-up credit and the
 *    loser's insert is a no-op - so it is written again as a monthly credit,
 *    unless its own invoice already earned (the redelivery case).
 *
 * The sign-up credit goes to the first invoice ChairBack RECORDS. Delivered
 * out of order, a business's second invoice may carry it and its first the
 * monthly credit: the total is identical, and each credit still answers for
 * its own invoice on a refund.
 */
async function earnDollarCredit(
  tx: Prisma.TransactionClient,
  input: {
    invoiceId: string;
    referredShopId: string;
    attributionId: string;
    account: EarningAccount;
    now: Date;
  },
): Promise<void> {
  const { account, now } = input;
  const suspended = account.status !== "ACTIVE";

  const insert = async (
    rewardType: "signup_credit" | "monthly_credit",
  ): Promise<boolean> => {
    // The rolling-year volume rule watches bring-ons only.
    const overThreshold =
      rewardType === "signup_credit" &&
      (await bringOnRewardsThisYear(tx, account.id, now)) >=
        AFFILIATE_POLICY.review.rollingYearQualifiedThreshold;
    const needsReview = suspended || overThreshold;
    const amountCents = dollarCreditCents(rewardType);
    const { count } = await tx.affiliateReward.createMany({
      data: [
        {
          affiliateAccountId: account.id,
          referredShopId: input.referredShopId,
          attributionId: input.attributionId,
          stripeInvoiceId: input.invoiceId,
          rewardType,
          amountCents,
          currency: AFFILIATE_POLICY.dollarCredit.currency,
          // Informational only: a dollar credit is never sized by a plan.
          basisPlan: account.shop.plan,
          status: needsReview ? "REVIEW_REQUIRED" : "PENDING",
          reviewReason: overThreshold ? "rolling_year_threshold" : null,
          qualifiedAt: now,
          holdEndsAt: holdEnd(now),
        },
      ],
      // createMany + skipDuplicates (ON CONFLICT DO NOTHING) rather than
      // create + catch: a P2002 caught in JavaScript does not un-abort the
      // surrounding Postgres transaction. count === 0 IS "a unique key said no".
      skipDuplicates: true,
    });
    if (count === 0) return false;

    const created = await tx.affiliateReward.findUnique({
      where: { stripeInvoiceId: input.invoiceId },
      select: { id: true },
    });
    await recordAffiliateEvent(tx, {
      shopId: input.referredShopId,
      accountId: account.id,
      type: needsReview ? "reward.review_flagged" : "reward.qualified",
      actor: { type: "system" },
      metadata: {
        toStatus: needsReview ? "REVIEW_REQUIRED" : "PENDING",
        rewardType,
        amountCents,
      },
    });
    // One email when a business is brought on. The monthly credits show on
    // the dashboard rather than landing in the inbox every month.
    if (created && rewardType === "signup_credit") {
      await enqueueAffiliateEmail(tx, {
        kind: "affiliate_reward_qualified",
        affiliateShopId: account.shopId,
        subjectId: created.id,
      });
    }
    return true;
  };

  const broughtOn = await tx.affiliateReward.findFirst({
    where: {
      referredShopId: input.referredShopId,
      rewardType: { in: [...AFFILIATE_BRING_ON_REWARD_TYPES] },
    },
    select: { id: true },
  });
  if (!broughtOn && (await insert("signup_credit"))) return;

  // Either the business was already brought on, or another invoice won the
  // race to bring it on, or this very invoice already earned (a redelivery
  // under a different event id). Only the last one earns nothing more.
  const own = await tx.affiliateReward.findUnique({
    where: { stripeInvoiceId: input.invoiceId },
    select: { id: true },
  });
  if (own) return;
  await insert("monthly_credit");
}

/** MONTH OFF (v1, unchanged): two paid invoices qualify one month off. */
async function qualifyMonthOff(
  tx: Prisma.TransactionClient,
  input: {
    referredShopId: string;
    attributionId: string;
    account: EarningAccount;
    now: Date;
  },
): Promise<void> {
  const { account } = input;
  const nowDate = input.now;
  const referredShop = { id: input.referredShopId };
  const attribution = { id: input.attributionId };

  const qualifying = await tx.affiliateQualifyingInvoice.count({
    where: { referredShopId: referredShop.id },
  });
  if (qualifying < AFFILIATE_POLICY.qualification.qualifyingInvoices) return;

  const amount = rewardAmountCents(account.shop.plan);
  // A referrer on no paid plan has no "one month of their own subscription"
  // to be worth. Held rather than guessed at.
  const held = amount === null;

  // Rolling-year volume: above the threshold a reward waits for a human.
  const recent = await bringOnRewardsThisYear(tx, account.id, nowDate);
  const overThreshold =
    recent >= AFFILIATE_POLICY.review.rollingYearQualifiedThreshold;

  const suspended = account.status !== "ACTIVE";
  const needsReview = held || overThreshold || suspended;

  const { count } = await tx.affiliateReward.createMany({
    data: [
      {
        affiliateAccountId: account.id,
        referredShopId: referredShop.id,
        attributionId: attribution.id,
        rewardType: AFFILIATE_POLICY.reward.kind,
        amountCents: amount?.cents ?? 1,
        currency: "usd",
        basisPlan: amount?.basisPlan ?? account.shop.plan,
        status: needsReview ? "REVIEW_REQUIRED" : "PENDING",
        reviewReason: overThreshold ? "rolling_year_threshold" : null,
        qualifiedAt: nowDate,
        holdEndsAt: holdEnd(nowDate),
      },
    ],
    // One bring-on reward per referred shop, ever. Two invoice events
    // arriving together both reach here; the partial unique index decides,
    // and the loser is a no-op rather than an exception that would abort
    // this transaction. A business already brought on with the sign-up
    // credit (before its affiliate switched styles) earns no month on top.
    skipDuplicates: true,
  });
  if (count === 0) return;

  await recordAffiliateEvent(tx, {
    shopId: referredShop.id,
    accountId: account.id,
    type: needsReview ? "reward.review_flagged" : "reward.qualified",
    actor: { type: "system" },
    metadata: {
      toStatus: needsReview ? "REVIEW_REQUIRED" : "PENDING",
      basisPlan: amount?.basisPlan ?? account.shop.plan,
    },
  });
  // "A month off is on the way" - createMany returns no id, so read the one
  // month-off row the partial unique index guarantees. Same transaction.
  const created = await tx.affiliateReward.findFirst({
    where: {
      referredShopId: referredShop.id,
      rewardType: AFFILIATE_POLICY.reward.kind,
    },
    select: { id: true },
  });
  if (created) {
    await enqueueAffiliateEmail(tx, {
      kind: "affiliate_reward_qualified",
      affiliateShopId: account.shopId,
      subjectId: created.id,
    });
  }
}

/**
 * A refund, dispute or credit note against money that qualified a referral.
 * The reward is reversed while it is still ours to reverse; once a credit has
 * been APPLIED the correction is a negative ledger entry, which belongs to the
 * credit-execution phase and is deliberately not invented here.
 */
async function reverseFromEvent(
  tx: Prisma.TransactionClient,
  type: string,
  object: Record<string, unknown>,
  nowMs?: number,
): Promise<void> {
  const invoiceId =
    typeof object.invoice === "string"
      ? object.invoice
      : ((object.invoice as { id?: string } | undefined)?.id ?? null);
  if (!invoiceId) return;

  const qualifying = await tx.affiliateQualifyingInvoice.findUnique({
    where: { stripeInvoiceId: invoiceId },
    select: { referredShopId: true },
  });
  if (!qualifying) return;

  const reason: ReversalReason =
    type === "charge.dispute.created"
      ? "payment_disputed"
      : type === "credit_note.created"
        ? "credit_note"
        : "invoice_refunded";

  // v2: the invoice's commission line, if it earned one. Not gated on the
  // commissions flag - switching earning off must never leave a refunded line
  // standing. Independent of the reward below, which is handled exactly as
  // before.
  await reverseCommissionForInvoice(tx, invoiceId, reason, new Date(nowMs ?? Date.now()));

  // Which rewards this money stood behind:
  //  - a DOLLAR credit answers for exactly its own invoice (stripeInvoiceId);
  //  - a MONTH OFF answers for the business's qualifying invoices as a whole,
  //    exactly as v1 did - any one of them refunded takes the month back.
  const candidates = await tx.affiliateReward.findMany({
    where: {
      OR: [
        { stripeInvoiceId: invoiceId },
        {
          referredShopId: qualifying.referredShopId,
          rewardType: AFFILIATE_POLICY.reward.kind,
        },
      ],
    },
    select: { id: true, affiliateAccountId: true, rewardType: true },
  });

  for (const reward of candidates) {
    // Only a reward we have not yet handed over can be reversed this way. The
    // CAS is the guard: if it is already RESERVED, APPLIED or REVERSED, count
    // is 0.
    const { count } = await tx.affiliateReward.updateMany({
      where: {
        id: reward.id,
        status: { in: ["PENDING", "AVAILABLE", "REVIEW_REQUIRED"] },
      },
      data: {
        status: "REVERSED",
        reversedAt: new Date(nowMs ?? Date.now()),
        reversalReason: reason,
      },
    });
    if (count === 0) continue;

    await recordAffiliateEvent(tx, {
      shopId: qualifying.referredShopId,
      accountId: reward.affiliateAccountId,
      type: "reward.reversed",
      actor: { type: "system" },
      metadata: {
        toStatus: "REVERSED",
        reversalReason: reason,
        rewardType: reward.rewardType,
      },
    });
    await enqueueAffiliateEmail(tx, {
      kind: "affiliate_reward_reversed",
      affiliateAccountId: reward.affiliateAccountId,
      subjectId: reward.id,
    });
  }
}

/**
 * The hold sweep: PENDING rewards whose hold has run out become AVAILABLE and
 * start their expiry clock.
 *
 * Off (the default) means DRY RUN - it still reports what it WOULD release and
 * writes nothing, so the numbers watched before enabling are the numbers you
 * get. Sends nothing either way; this program has no SMS and no email.
 */
export async function releaseAffiliateRewardHolds(opts?: {
  dryRun?: boolean;
  nowMs?: number;
}): Promise<{ due: number; released: number; dryRun: boolean }> {
  const dryRun = opts?.dryRun ?? !qualificationEnabled();
  const now = new Date(opts?.nowMs ?? Date.now());

  return runAsOwner(async (tx) => {
    const due = await tx.affiliateReward.findMany({
      where: { status: "PENDING", holdEndsAt: { lte: now } },
      select: {
        id: true,
        referredShopId: true,
        affiliateAccountId: true,
        rewardType: true,
      },
      take: 200,
    });
    if (dryRun || due.length === 0) {
      return { due: due.length, released: 0, dryRun };
    }
    const monthOffExpiresAt = new Date(now);
    monthOffExpiresAt.setUTCMonth(
      monthOffExpiresAt.getUTCMonth() + AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
    );
    let released = 0;
    for (const reward of due) {
      // A month off keeps v1's expiry clock. Dollar credit never expires
      // (AFFILIATE_POLICY.dollarCredit.expires is false): it waits, however
      // long, for the affiliate to have a paid plan to land on.
      const dollar = isDollarRewardType(reward.rewardType);
      const expiresAt =
        dollar && !AFFILIATE_POLICY.dollarCredit.expires ? null : monthOffExpiresAt;
      // CAS per reward: a second worker finds count 0 and moves on.
      const { count } = await tx.affiliateReward.updateMany({
        where: { id: reward.id, status: "PENDING" },
        data: { status: "AVAILABLE", availableAt: now, expiresAt },
      });
      if (count === 0) continue;
      released += 1;
      await recordAffiliateEvent(tx, {
        shopId: reward.referredShopId,
        accountId: reward.affiliateAccountId,
        type: "reward.available",
        actor: { type: "system" },
        metadata: {
          fromStatus: "PENDING",
          toStatus: "AVAILABLE",
          rewardType: reward.rewardType,
        },
      });
      // A monthly credit clearing its hold is routine; only a bring-on
      // reward is worth an email.
      if (reward.rewardType !== "monthly_credit") {
        await enqueueAffiliateEmail(tx, {
          kind: "affiliate_reward_available",
          affiliateAccountId: reward.affiliateAccountId,
          subjectId: reward.id,
        });
      }
    }
    return { due: due.length, released, dryRun };
  });
}
