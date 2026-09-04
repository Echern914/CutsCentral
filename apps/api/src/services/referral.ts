import { prisma } from "@chairback/db";
import { REFERRAL, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";

/**
 * Referral program: "refer a barber, you both get a month free".
 *
 * THE SHAPE OF IT
 *  1. A shop opens the referrals page; `ensureReferralCode` mints their code.
 *  2. They share `<app>/?ref=CODE`. The web middleware already captures `ref`
 *     into a first-party cookie and signup persists it to User.referralCode -
 *     that attribution plumbing predates this program and is reused as-is.
 *  3. The friend creates a shop. `linkReferralOnShopCreate` records a PENDING
 *     Referral and extends the FRIEND's trial immediately (their side of the
 *     deal, visible right away).
 *  4. The friend's first invoice actually clears. Only then does
 *     `grantReferralReward` pay the REFERRER.
 *
 * WHY THE REFERRER WAITS FOR CLEARED MONEY
 * Rewarding on signup would let anyone mint free months with throwaway email
 * addresses. Rewarding when a card is entered is better but still leaks: a
 * trial can be cancelled before it charges. Waiting for a paid invoice means
 * farming the reward costs more than the reward is worth.
 */

/** Days added to a trial for one referral reward. */
const REWARD_MS = REFERRAL.rewardDays * 86_400_000;

/**
 * Mint this shop's share code if it doesn't have one yet, and return it.
 *
 * Lazy rather than at shop creation so no backfill was needed for existing
 * shops. Races (two tabs opening the page at once) are resolved by the unique
 * index: the loser re-reads the winner's code instead of overwriting it, so a
 * shop's code never changes out from under a link they've already shared.
 */
export async function ensureReferralCode(shopId: string): Promise<string | null> {
  const existing = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { referralCode: true },
  });
  if (!existing) return null;
  if (existing.referralCode) return existing.referralCode;

  // A few attempts in case of an astronomically unlikely code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomToken(REFERRAL.codeBytes);
    try {
      const updated = await prisma.shop.update({
        where: { id: shopId },
        data: { referralCode: code },
        select: { referralCode: true },
      });
      return updated.referralCode;
    } catch {
      // Either this code collided, or a concurrent request already set one.
      // Re-read: if someone else won, their code is now the shop's code.
      const now = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { referralCode: true },
      });
      if (now?.referralCode) return now.referralCode;
    }
  }
  logger.error({ shopId }, "referral: could not mint a code after 5 attempts");
  return null;
}

/**
 * Called right after a shop is created. If its owner arrived with a referral
 * code, record the referral and give the FRIEND their extra month now.
 *
 * Never throws: a referral is a growth nicety, and failing it must not fail
 * shop creation. Returns whether a referral was recorded, for logging/tests.
 */
export async function linkReferralOnShopCreate(opts: {
  shopId: string;
  ownerId: string;
  /** The code the owner arrived with (User.referralCode), if any. */
  code: string | null | undefined;
}): Promise<boolean> {
  const code = opts.code?.trim();
  if (!code) return false;

  try {
    const referrer = await prisma.shop.findUnique({
      where: { referralCode: code },
      select: { id: true, ownerId: true },
    });
    // An unknown code is not an error: codes appear in URLs, and a typo or a
    // stale link should simply not attribute anything.
    if (!referrer) return false;

    // Self-referral: the same person using their own link on a second shop.
    // Recorded as VOID rather than skipped so it's visible in the data instead
    // of looking like the code was never used.
    const selfReferred = referrer.ownerId === opts.ownerId || referrer.id === opts.shopId;

    await prisma.referral.create({
      data: {
        referrerShopId: referrer.id,
        referredShopId: opts.shopId,
        code,
        status: selfReferred ? "VOID" : "PENDING",
      },
    });
    if (selfReferred) {
      logger.warn(
        { shopId: opts.shopId, referrerShopId: referrer.id },
        "referral: self-referral voided",
      );
      return false;
    }

    // The friend's side of the deal, applied immediately: an extra month on
    // their trial. checkout then passes this through to Stripe as trial_end
    // (see createCheckoutSession), so it becomes a real free month rather than
    // just a longer in-app grace period.
    await extendTrial(opts.shopId, REWARD_MS);
    logger.info(
      { shopId: opts.shopId, referrerShopId: referrer.id },
      "referral: linked, friend's trial extended",
    );
    return true;
  } catch (err) {
    // Unique violation = this shop already has a referral row (a retry). Any
    // other failure is logged and swallowed: never break shop creation.
    logger.warn(
      { shopId: opts.shopId, errName: err instanceof Error ? err.name : "unknown" },
      "referral: link failed",
    );
    return false;
  }
}

/**
 * The friend's first payment cleared - pay the referrer.
 *
 * Idempotent by compare-and-set: the PENDING -> REWARDED flip happens FIRST and
 * only proceeds if it actually changed a row. Stripe redelivers webhooks for
 * days and delivers them out of order, so without this a replayed invoice would
 * hand out a second free month. Ordering the CAS before the grant means a crash
 * mid-grant loses a reward rather than paying it twice - the safe direction for
 * something that costs real money. Such a row is visible as REWARDED with a
 * null rewardKind.
 */
export async function grantReferralReward(
  referredShopId: string,
  opts: { qualifyingInvoiceId?: string | null } = {},
): Promise<void> {
  const referral = await prisma.referral.findUnique({
    where: { referredShopId },
    select: { id: true, referrerShopId: true, status: true },
  });
  // No referral, or already paid/voided - nothing to do. The overwhelmingly
  // common case, since most shops weren't referred.
  if (!referral || referral.status !== "PENDING") return;

  const now = new Date();
  // CAS: only the caller that actually flips PENDING -> REWARDED may grant.
  // `data` is non-empty, so a count of 0 genuinely means "someone else won".
  // The qualifying invoice is recorded in the same write, so a later refund
  // of THAT invoice can find this reward (flagReferralForReview).
  const { count } = await prisma.referral.updateMany({
    where: { id: referral.id, status: "PENDING" },
    data: {
      status: "REWARDED",
      qualifiedAt: now,
      rewardedAt: now,
      qualifyingInvoiceId: opts.qualifyingInvoiceId ?? undefined,
    },
  });
  if (count === 0) return;

  try {
    const kind = await payReferrer(referral.referrerShopId, referral.id);
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        rewardKind: kind.kind,
        rewardAmountCents: kind.amountCents,
        stripeBalanceTransactionId: kind.stripeBalanceTransactionId,
      },
    });
    logger.info(
      { referralId: referral.id, shopId: referral.referrerShopId, kind: kind.kind },
      "referral: referrer rewarded",
    );
  } catch (err) {
    // The row is already REWARDED, so this will not retry on the next replay.
    // Loud because it needs manual repair: someone earned a month and didn't
    // get it, and no other code path will ever notice on its own.
    logger.error(
      {
        referralId: referral.id,
        shopId: referral.referrerShopId,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "referral: MARKED REWARDED BUT GRANT FAILED - needs manual credit",
    );
    // 🔴 Sentry, not just the log stream. This is money that a person earned
    // and did not receive, the failure is silent by construction (the CAS
    // already committed, so nothing retries), and the log line would otherwise
    // wait for someone to go looking. No PII: ids only.
    captureError(err, {
      referralId: referral.id,
      referrerShopId: referral.referrerShopId,
      reason: "referral_grant_failed_after_cas",
    });
  }
}

/**
 * Give one shop a free month, by whichever route fits their billing state.
 *
 * A shop that hasn't subscribed yet just gets more trial - and because checkout
 * derives Stripe's trial_end from trialEndsAt, that converts into a genuinely
 * free month when they do subscribe. A shop that is ALREADY paying can't use
 * trial time, so they get account credit worth their own monthly price, which
 * Stripe applies to their next invoice automatically.
 */
async function payReferrer(
  shopId: string,
  referralId: string,
): Promise<{
  kind: "trial_extension" | "stripe_credit";
  amountCents: number | null;
  stripeBalanceTransactionId: string | null;
}> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true, subscriptionStatus: true },
  });
  if (!shop) throw new Error(`referrer shop ${shopId} not found`);

  const paying =
    shop.stripeCustomerId !== null &&
    shop.stripeSubscriptionId !== null &&
    ACTIVE_FOR_CREDIT.has(shop.subscriptionStatus);

  if (!paying) {
    await extendTrial(shopId, REWARD_MS);
    return { kind: "trial_extension", amountCents: null, stripeBalanceTransactionId: null };
  }

  const amountCents = await monthlyPriceCents(shop.stripeSubscriptionId!);
  // A negative balance transaction is Stripe's "account credit": it is consumed
  // by the next invoice automatically, so there is nothing to schedule or
  // reconcile later. The idempotency key is the referral's own id: the CAS
  // above already makes a second grant impossible in our ledger, and the key
  // makes a retried REQUEST (a timeout after Stripe accepted the first)
  // collapse to the one credit at Stripe as well. The transaction id comes
  // back and is stored, so the credit can be found by id, not by faith.
  const { stripeClient } = await import("../billing/stripe.js");
  const txn = await stripeClient().customers.createBalanceTransaction(
    shop.stripeCustomerId!,
    {
      amount: -amountCents,
      currency: "usd",
      description: "ChairBack referral reward - one month free",
      metadata: { referralId },
    },
    { idempotencyKey: `referral-reward:${referralId}` },
  );
  return { kind: "stripe_credit", amountCents, stripeBalanceTransactionId: txn.id };
}

export type ReferralReviewReason = "invoice_refunded" | "payment_disputed" | "credit_note";

/**
 * The money that paid a referrer came back: a refund, a dispute or a credit
 * note against the invoice that qualified the referral.
 *
 * This FLAGS - it never reverses. A trial month already granted may already
 * be half used; a Stripe credit may already have been consumed by the next
 * invoice. Clawing either back is a policy a person decides, per case, with
 * the Stripe dashboard open; what this guarantees is that the case is never
 * invisible. Idempotent: one flag per referral, the first reason wins, and a
 * redelivered event finds nothing left to flag.
 */
export async function flagReferralForReview(
  qualifyingInvoiceId: string,
  reason: ReferralReviewReason,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.referral.updateMany({
    where: { qualifyingInvoiceId, status: "REWARDED", reviewFlaggedAt: null },
    data: { reviewFlaggedAt: now, reviewReason: reason },
  });
  if (count > 0) {
    logger.error(
      { qualifyingInvoiceId, reason, flagged: count },
      "referral: the invoice that paid a referrer was reversed - reward flagged for review",
    );
    captureError(new Error("referral reward flagged for review"), {
      qualifyingInvoiceId,
      reason,
      flagged: count,
      what: "referral_reward_review",
    });
  }
  return count;
}

/** Subscription states where a shop is really paying and can use credit. */
const ACTIVE_FOR_CREDIT = new Set(["active", "trialing", "past_due"]);

/** What this subscription charges per period, in cents. */
async function monthlyPriceCents(subscriptionId: string): Promise<number> {
  const { stripeClient } = await import("../billing/stripe.js");
  const sub = await stripeClient().subscriptions.retrieve(subscriptionId);
  const unit = sub.items.data[0]?.price?.unit_amount;
  if (typeof unit !== "number" || unit <= 0) {
    // 🔴 THE HAZARD TO KNOW ABOUT, and it is quiet.
    //
    // `unit_amount` is NULL for TIERED and METERED prices - Stripe puts the
    // money in `tiers` / usage instead. Every ChairBack price is flat today, so
    // this throw is unreachable; the day someone moves a plan to tiered
    // pricing it starts firing, and because grantReferralReward has ALREADY
    // flipped the row to REWARDED before calling us, the throw does not refuse
    // the reward - it strands it. The referrer stays marked paid with a null
    // rewardKind and never sees a cent.
    //
    // So if you are here because tiered pricing arrived: compute the amount
    // from the price's tiers (or the upcoming invoice) rather than widening
    // this check, and re-read the CAS ordering in grantReferralReward first.
    //
    // Reading item[0] is safe on purpose: the base subscription carries
    // exactly one item (upgradeSubscriptionToPremiumAi REPLACES its price
    // rather than adding), and the receptionist add-on is a SEPARATE
    // subscription that both webhook handlers refuse to write to
    // Shop.stripeSubscriptionId.
    throw new Error(`subscription ${subscriptionId} has no usable unit_amount`);
  }
  return unit;
}

/**
 * Push a shop's trial out by `ms`.
 *
 * Measured from whichever is later, now or the existing end: extending an
 * ALREADY-EXPIRED trial from its old end date would hand back a month that had
 * already elapsed and grant nothing at all.
 */
async function extendTrial(shopId: string, ms: number): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { trialEndsAt: true },
  });
  const base = Math.max(Date.now(), shop?.trialEndsAt?.getTime() ?? 0);
  await prisma.shop.update({
    where: { id: shopId },
    data: { trialEndsAt: new Date(base + ms) },
  });
}

/**
 * The safety net under grantReferralReward: find referrals marked paid that
 * never actually were.
 *
 * `status = REWARDED` with a NULL `rewardKind` is unambiguous. The CAS flips
 * the row to REWARDED FIRST and only then grants, writing rewardKind on
 * success - so that pair means "we committed to paying this person and then
 * didn't". There is no other way to produce it.
 *
 * 🔴 Why this exists when the catch already reports to Sentry: the catch can
 * only fire if the process survives to run it. The CAS commits before the
 * grant, so a deploy, an OOM or a lost connection in between strands the row
 * with NO exception raised anywhere. Those are exactly the ones nobody would
 * ever hear about, and they are indistinguishable afterwards from a Stripe
 * failure - which is fine, because the repair is the same either way.
 *
 * Read-only by construction. It reports; a human decides what to credit.
 */
export async function findStrandedReferralGrants(limit = 50): Promise<{
  count: number;
  referralIds: string[];
}> {
  const rows = await prisma.referral.findMany({
    where: { status: "REWARDED", rewardKind: null },
    orderBy: { rewardedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const count = await prisma.referral.count({
    where: { status: "REWARDED", rewardKind: null },
  });
  return { count, referralIds: rows.map((r) => r.id) };
}

/**
 * The scheduled half. Alerts and returns counts; writes nothing, ever.
 *
 * Fires on every tick while a stranded row exists rather than once: this is
 * someone's unpaid month, and an alert that stops nagging before the money
 * moves is an alert that gets forgotten.
 */
export async function auditReferralGrants(): Promise<{
  stranded: number;
  referralIds: string[];
  /** Rewards whose qualifying invoice was refunded, disputed or credited. */
  flagged: number;
  flaggedIds: string[];
}> {
  const { count, referralIds } = await findStrandedReferralGrants();
  if (count > 0) {
    logger.error(
      { stranded: count, referralIds },
      "referral: rewards marked REWARDED with no grant recorded - owed and unpaid",
    );
    captureError(
      new Error(`${count} referral reward(s) marked REWARDED but never granted`),
      { stranded: count, referralIds, reason: "referral_grant_stranded" },
    );
  }
  // The other open question: rewards paid on money that has since come back.
  // Nagged on every tick for the same reason as the stranded ones - a flag
  // that stops repeating before a person acts is a flag that gets forgotten.
  const flaggedRows = await prisma.referral.findMany({
    where: { reviewFlaggedAt: { not: null } },
    orderBy: { reviewFlaggedAt: "asc" },
    take: 50,
    select: { id: true },
  });
  const flagged = await prisma.referral.count({ where: { reviewFlaggedAt: { not: null } } });
  const flaggedIds = flaggedRows.map((r) => r.id);
  if (flagged > 0) {
    logger.error(
      { flagged, flaggedIds },
      "referral: rewards whose qualifying invoice was reversed - review and decide, per case",
    );
  }
  return { stranded: count, referralIds, flagged, flaggedIds };
}
