import { AFFILIATE_POLICY, apiEnv, randomToken } from "@chairback/config";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { stripeClient } from "../billing/stripe.js";
import { logger } from "../logger.js";
import { recordAffiliateEvent } from "../services/affiliateAudit.js";

/**
 * Credit execution: an AVAILABLE reward becomes a Stripe customer-balance
 * credit on the affiliate's own account, exactly once.
 *
 * Three moves, each its own transaction, each a CAS:
 *
 *   RESERVE   AVAILABLE reward  ->  RESERVED + one PENDING operation
 *   EXECUTE   PENDING operation ->  Stripe createBalanceTransaction -> APPLIED
 *   EXPIRE    AVAILABLE (or a RESERVED one whose operation never landed)
 *             past its expiry  ->  EXPIRED
 *
 * 🔴 THE LEDGER IS THE TRUTH, STRIPE IS THE MECHANISM. Stripe's customer
 * balance is a single scalar with no memory of why; the operation row (and
 * the reward it belongs to) is what says a credit was applied, for how much,
 * and under which Stripe transaction id.
 *
 * 🔴 EXACTLY ONCE, TWO LAYERS. The operation's UNIQUE rewardId makes "one
 * operation per reward" structural, and the Stripe call carries the durable
 * idempotency key `affiliate-reward:<rewardId>` so a retry of an ambiguous
 * attempt is collapsed by Stripe - within its 24-hour window. The window
 * check happens BEFORE the request, on a marker written AHEAD of the request
 * (the email outbox's write-ahead rule, for the same reason: a crash after
 * acceptance leaves no other trace).
 *
 * 🔴 NEVER MORE THAN A REAL MONTH. The reward snapshotted the plan's LIST
 * price at qualification. A referrer on a discounted subscription must not be
 * credited more than they pay, so the applied amount is the smaller of the
 * snapshot and the subscription's current unit_amount, read from Stripe at
 * execution and recorded on the operation.
 *
 * A shop that is not paying (no subscription, or one that is not active) is
 * not refused - there is nothing to apply a credit to yet - so the operation
 * is deferred a day at a time until they subscribe or the reward expires.
 *
 * Dark until AFFILIATE_CREDIT_EXECUTION_ENABLED: the job reports what it
 * WOULD do and writes nothing.
 */

export const AFFILIATE_CREDIT_JOB = "affiliate-credit-execution";

/** Real Stripe calls permitted per operation. */
export const MAX_ATTEMPTS = 5;
/** Stripe honours an idempotency key for 24h from the first request. */
export const STRIPE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A claim older than this is treated as abandoned by a dead worker. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;
/** Not paying yet: look again tomorrow. */
const NOT_PAYING_RETRY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 60 * 60_000, 60 * 60_000];
const BATCH = 25;

/** Subscription states where a shop is really paying and can use credit. */
const ACTIVE_FOR_CREDIT = new Set(["active", "trialing", "past_due"]);

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
}

export function creditExecutionEnabled(): boolean {
  const env = apiEnv();
  return env.AFFILIATE_PROGRAM_ENABLED && env.AFFILIATE_CREDIT_EXECUTION_ENABLED;
}

//  RESERVE

export async function reserveAffiliateCredits(opts: {
  now: Date;
  dryRun?: boolean;
}): Promise<{ due: number; reserved: number }> {
  const due = await runAsOwner((tx) =>
    tx.affiliateReward.findMany({
      where: { status: "AVAILABLE" },
      select: { id: true, affiliateAccountId: true, amountCents: true, currency: true },
      orderBy: { availableAt: "asc" },
      take: 200,
    }),
  );
  if (opts.dryRun || due.length === 0) return { due: due.length, reserved: 0 };

  let reserved = 0;
  for (const reward of due) {
    const ok = await runAsOwner(async (tx) => {
      const account = await tx.affiliateAccount.findUnique({
        where: { id: reward.affiliateAccountId },
        select: { shopId: true },
      });
      if (!account) return false;
      // An earlier operation that was CANCELED (admin released the reward)
      // is re-armed; any other existing operation means this reward is
      // already spoken for and the reward's status is what's stale.
      const existing = await tx.affiliateCreditOperation.findUnique({
        where: { rewardId: reward.id },
        select: { id: true, status: true },
      });
      if (existing && existing.status !== "CANCELED") return false;

      const { count } = await tx.affiliateReward.updateMany({
        where: { id: reward.id, status: "AVAILABLE" },
        data: { status: "RESERVED" },
      });
      if (count === 0) return false;

      if (existing) {
        await tx.affiliateCreditOperation.update({
          where: { id: existing.id },
          data: {
            status: "PENDING",
            attempts: 0,
            firstProviderAttemptAt: null,
            lastAttemptAmbiguous: false,
            nextAttemptAt: new Date(0),
            claimedAt: null,
            claimToken: null,
            lastError: null,
          },
        });
      } else {
        await tx.affiliateCreditOperation.create({
          data: {
            rewardId: reward.id,
            affiliateAccountId: reward.affiliateAccountId,
            shopId: account.shopId,
            status: "PENDING",
            amountCents: reward.amountCents,
            currency: reward.currency,
            nextAttemptAt: new Date(0),
          },
        });
      }
      return true;
    });
    if (ok) reserved += 1;
  }
  return { due: due.length, reserved };
}

//  EXECUTE

export type CreditOutcome =
  | "applied"
  | "deferred"
  | "retry"
  | "failed"
  | "abandoned"
  | "superseded"
  | "stale_claim"
  | "skipped"
  | "not_found";

export interface ExecuteResult {
  claimed: number;
  applied: number;
  deferred: number;
  retry: number;
  failed: number;
  abandoned: number;
  superseded: number;
  staleClaim: number;
}

export async function executeAffiliateCredits(opts: {
  now: Date;
  batch?: number;
}): Promise<ExecuteResult> {
  const now = opts.now;
  const batch = opts.batch ?? BATCH;
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const claimToken = randomToken(16);
  const claimed = await runAsOwner((tx) =>
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "AffiliateCreditOperation"
         SET "claimedAt" = ${now.toISOString()}::timestamp,
             "claimToken" = ${claimToken},
             "updatedAt" = now()
       WHERE "id" IN (
         SELECT "id" FROM "AffiliateCreditOperation"
          WHERE "status" = 'PENDING'
            AND ("nextAttemptAt" IS NULL
                 OR "nextAttemptAt" <= ${now.toISOString()}::timestamp)
            AND ("claimedAt" IS NULL OR "claimedAt" < ${staleBefore.toISOString()}::timestamp)
          ORDER BY "nextAttemptAt" NULLS FIRST, "createdAt"
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING "id"`),
  );
  const result: ExecuteResult = {
    claimed: claimed.length,
    applied: 0,
    deferred: 0,
    retry: 0,
    failed: 0,
    abandoned: 0,
    superseded: 0,
    staleClaim: 0,
  };
  for (const row of claimed) {
    const outcome = await deliverCredit({ operationId: row.id, claimToken, now }).catch(
      () => "retry" as const,
    );
    if (outcome === "applied") result.applied++;
    else if (outcome === "deferred") result.deferred++;
    else if (outcome === "retry") result.retry++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "abandoned") result.abandoned++;
    else if (outcome === "superseded") result.superseded++;
    else if (outcome === "stale_claim") result.staleClaim++;
  }
  if (result.applied > 0 || result.abandoned > 0 || result.failed > 0) {
    logger.info(result, "affiliate credits executed");
  }
  return result;
}

/** Stripe error types after which NOTHING was applied - safe to retry later
 *  even outside the idempotency window. */
const DEFINITIVE_STRIPE_TYPES = new Set([
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeCardError",
  "StripeRateLimitError",
  "StripeIdempotencyError",
]);

function classifyStripeError(err: unknown): { definitive: boolean; classification: string } {
  const type = (err as { type?: string } | null)?.type;
  if (typeof type === "string" && DEFINITIVE_STRIPE_TYPES.has(type)) {
    return { definitive: true, classification: type.replace(/^Stripe/, "").replace(/Error$/, "").toLowerCase() };
  }
  return { definitive: false, classification: "transport_error" };
}

export async function deliverCredit(params: {
  operationId: string;
  claimToken: string;
  now: Date;
}): Promise<CreditOutcome> {
  const { now } = params;
  const op = await runAsOwner((tx) =>
    tx.affiliateCreditOperation.findUnique({ where: { id: params.operationId } }),
  );
  if (!op) return "not_found";
  if (op.status !== "PENDING") return "skipped";

  // Still ours to apply? Reversed, expired or released rewards leave the
  // operation behind; it is canceled rather than executed.
  const reward = await runAsOwner((tx) =>
    tx.affiliateReward.findUnique({
      where: { id: op.rewardId },
      select: { status: true, referredShopId: true, affiliateAccountId: true, basisPlan: true },
    }),
  );
  if (!reward || reward.status !== "RESERVED") {
    await settle(op.id, "CANCELED", "reward_not_reserved");
    return "superseded";
  }

  // The expired-ambiguous guard, before anything that could call Stripe.
  const expired = await runAsOwner((tx) =>
    tx.affiliateCreditOperation.updateMany({
      where: {
        id: op.id,
        status: "PENDING",
        claimToken: params.claimToken,
        lastAttemptAmbiguous: true,
        firstProviderAttemptAt: { lte: new Date(now.getTime() - STRIPE_IDEMPOTENCY_WINDOW_MS) },
      },
      data: {
        status: "ABANDONED",
        lastError: "idempotency_window_expired",
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
      },
    }),
  );
  if (expired.count > 0) {
    logger.error(
      { operationId: op.id, rewardId: op.rewardId, reason: "idempotency_window_expired" },
      "affiliate credit abandoned unapplied - an earlier attempt may already have landed; check Stripe",
    );
    return "abandoned";
  }

  const shop = await prisma.shop.findUnique({
    where: { id: op.shopId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true, subscriptionStatus: true },
  });
  const paying =
    !!shop?.stripeCustomerId &&
    !!shop.stripeSubscriptionId &&
    ACTIVE_FOR_CREDIT.has(shop.subscriptionStatus);
  if (!paying) {
    await release(op.id, "not_paying", new Date(now.getTime() + NOT_PAYING_RETRY_MS), { ambiguous: false });
    return "deferred";
  }

  // Reconcile against the REAL subscription: never more than a real month.
  let unitAmount: number | null = null;
  try {
    const sub = await stripeClient().subscriptions.retrieve(shop.stripeSubscriptionId!);
    const unit = sub.items.data[0]?.price?.unit_amount;
    unitAmount = typeof unit === "number" && unit > 0 ? unit : null;
  } catch (err) {
    const c = classifyStripeError(err);
    await release(op.id, `subscription_${c.classification}`, new Date(now.getTime() + backoffFor(op.attempts)), { ambiguous: false });
    return "retry";
  }
  if (unitAmount === null) {
    // Tiered / metered pricing has no unit_amount. Nothing was applied;
    // this needs a person, not a retry loop.
    await settle(op.id, "FAILED", "no_unit_amount");
    logger.error({ operationId: op.id, rewardId: op.rewardId }, "affiliate credit failed - subscription has no usable unit_amount");
    return "failed";
  }
  const appliedCents = Math.min(op.amountCents, unitAmount);

  const attemptNo = await reserveAttempt(op.id, params.claimToken, now);
  if (attemptNo === null) return classifyRefusedReservation(op.id, params.claimToken);

  // ---- THE BOUNDARY: "an attempt may be in flight" is on disk from here.
  try {
    const txn = await stripeClient().customers.createBalanceTransaction(
      shop.stripeCustomerId!,
      {
        amount: -appliedCents,
        currency: op.currency,
        description: "ChairBack affiliate reward - one month off",
        metadata: { affiliateRewardId: op.rewardId, affiliateOperationId: op.id },
      },
      { idempotencyKey: `affiliate-reward:${op.rewardId}` },
    );
    await runAsOwner(async (tx) => {
      await tx.affiliateCreditOperation.update({
        where: { id: op.id },
        data: {
          status: "APPLIED",
          appliedCents,
          appliedAt: now,
          stripeCustomerId: shop.stripeCustomerId,
          stripeBalanceTransactionId: txn.id,
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
          lastError: null,
          lastAttemptAmbiguous: false,
        },
      });
      await tx.affiliateReward.updateMany({
        where: { id: op.rewardId, status: "RESERVED" },
        data: { status: "APPLIED" },
      });
      await recordAffiliateEvent(tx, {
        shopId: reward.referredShopId,
        accountId: reward.affiliateAccountId,
        type: "credit.applied",
        actor: { type: "system" },
        metadata: { fromStatus: "RESERVED", toStatus: "APPLIED", basisPlan: reward.basisPlan },
      });
    });
    return "applied";
  } catch (err) {
    const c = classifyStripeError(err);
    if (c.definitive) return definitiveFailure(op.id, attemptNo, c.classification, now);
    return ambiguous(op.id, attemptNo, now, c.classification);
  }
}

async function reserveAttempt(operationId: string, claimToken: string, now: Date): Promise<number | null> {
  const rows = await runAsOwner((tx) =>
    tx.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      UPDATE "AffiliateCreditOperation"
         SET "attempts" = "attempts" + 1,
             "firstProviderAttemptAt" = COALESCE("firstProviderAttemptAt", ${now.toISOString()}::timestamp),
             "lastAttemptAmbiguous" = true,
             "updatedAt" = now()
       WHERE "id" = ${operationId}
         AND "status" = 'PENDING'
         AND "claimToken" = ${claimToken}
         AND "attempts" < ${MAX_ATTEMPTS}
      RETURNING "attempts"`),
  );
  return rows[0] ? Number(rows[0].attempts) : null;
}

async function classifyRefusedReservation(operationId: string, claimToken: string): Promise<CreditOutcome> {
  const row = await runAsOwner((tx) =>
    tx.affiliateCreditOperation.findUnique({
      where: { id: operationId },
      select: { status: true, claimToken: true, lastAttemptAmbiguous: true },
    }),
  );
  if (!row) return "not_found";
  if (row.status !== "PENDING") return "skipped";
  if (row.claimToken !== claimToken) return "stale_claim";
  const status = row.lastAttemptAmbiguous ? "ABANDONED" : "FAILED";
  await settle(operationId, status, "max_attempts");
  logger.error({ operationId, reason: "max_attempts", outcome: status }, "affiliate credit gave up - attempt budget exhausted");
  return row.lastAttemptAmbiguous ? "abandoned" : "failed";
}

async function definitiveFailure(operationId: string, attemptNo: number, classification: string, now: Date): Promise<CreditOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    await settle(operationId, "FAILED", classification, { ambiguous: false });
    logger.error({ operationId, reason: classification, attempts: attemptNo }, "affiliate credit rejected by Stripe, giving up");
    return "failed";
  }
  await release(operationId, classification, new Date(now.getTime() + backoffFor(attemptNo)), { ambiguous: false });
  return "retry";
}

async function ambiguous(operationId: string, attemptNo: number, now: Date, classification: string): Promise<CreditOutcome> {
  const row = await runAsOwner((tx) =>
    tx.affiliateCreditOperation.findUnique({ where: { id: operationId }, select: { firstProviderAttemptAt: true } }),
  );
  const firstAttemptAt = row?.firstProviderAttemptAt ?? now;
  const windowClosed = now.getTime() - firstAttemptAt.getTime() >= STRIPE_IDEMPOTENCY_WINDOW_MS;
  if (windowClosed || attemptNo >= MAX_ATTEMPTS) {
    await settle(operationId, "ABANDONED", classification, { ambiguous: true });
    logger.error({ operationId, reason: classification, attempts: attemptNo }, "affiliate credit gave up after an ambiguous attempt - check Stripe before touching it");
    return "abandoned";
  }
  await release(operationId, classification, new Date(now.getTime() + backoffFor(attemptNo)), { ambiguous: true });
  return "retry";
}

async function settle(
  operationId: string,
  status: "FAILED" | "ABANDONED" | "CANCELED",
  lastError: string,
  opts: { ambiguous?: boolean } = {},
): Promise<void> {
  await runAsOwner((tx) =>
    tx.affiliateCreditOperation.update({
      where: { id: operationId },
      data: {
        status,
        lastError,
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
        ...(opts.ambiguous === undefined ? {} : { lastAttemptAmbiguous: opts.ambiguous }),
      },
    }),
  ).catch(() => {});
}

async function release(operationId: string, lastError: string, nextAttemptAt: Date, opts: { ambiguous: boolean }): Promise<void> {
  await runAsOwner((tx) =>
    tx.affiliateCreditOperation.update({
      where: { id: operationId },
      data: { claimedAt: null, lastError, nextAttemptAt, lastAttemptAmbiguous: opts.ambiguous },
    }),
  ).catch(() => {});
}

//  EXPIRE

export async function expireAffiliateRewards(opts: {
  now: Date;
  dryRun?: boolean;
}): Promise<{ due: number; expired: number }> {
  const now = opts.now;
  const due = await runAsOwner((tx) =>
    tx.affiliateReward.findMany({
      where: { status: { in: ["AVAILABLE", "RESERVED"] }, expiresAt: { lte: now } },
      select: { id: true, status: true, referredShopId: true, affiliateAccountId: true },
      take: 200,
    }),
  );
  if (opts.dryRun || due.length === 0) return { due: due.length, expired: 0 };
  let expired = 0;
  for (const reward of due) {
    const ok = await runAsOwner(async (tx) => {
      if (reward.status === "RESERVED") {
        // Only a reward whose operation never landed may expire; an APPLIED
        // operation means the money moved and the reward is not ours to expire.
        const op = await tx.affiliateCreditOperation.findUnique({
          where: { rewardId: reward.id },
          select: { id: true, status: true },
        });
        if (op && op.status === "APPLIED") return false;
        if (op && op.status === "PENDING") {
          await tx.affiliateCreditOperation.update({
            where: { id: op.id },
            data: { status: "CANCELED", lastError: "reward_expired", claimedAt: null, claimToken: null, nextAttemptAt: null },
          });
        }
      }
      const { count } = await tx.affiliateReward.updateMany({
        where: { id: reward.id, status: reward.status },
        data: { status: "EXPIRED" },
      });
      if (count === 0) return false;
      await recordAffiliateEvent(tx, {
        shopId: reward.referredShopId,
        accountId: reward.affiliateAccountId,
        type: "reward.expired",
        actor: { type: "system" },
        metadata: { fromStatus: reward.status, toStatus: "EXPIRED" },
      });
      return true;
    });
    if (ok) expired += 1;
  }
  return { due: due.length, expired };
}

//  THE JOB

export interface CreditJobResult {
  dryRun: boolean;
  reserve: { due: number; reserved: number };
  execute: ExecuteResult | null;
  expire: { due: number; expired: number };
}

/**
 * Reserve, execute, expire. Off (the default) means DRY RUN: it reports what
 * it would reserve and expire and touches nothing, so the numbers watched
 * before enabling are the numbers you get.
 */
export async function runAffiliateCreditExecution(opts?: {
  now?: Date;
  dryRun?: boolean;
}): Promise<CreditJobResult> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? !creditExecutionEnabled();
  const reserve = await reserveAffiliateCredits({ now, dryRun });
  const execute = dryRun ? null : await executeAffiliateCredits({ now });
  const expire = await expireAffiliateRewards({ now, dryRun });
  return { dryRun, reserve, execute, expire };
}

//  OPERATOR

export type CreditAdminResult =
  | { ok: true; value: { id: string; status: string } }
  | { ok: false; error: "not_found" | "invalid_transition" };

/** FAILED (definitive - nothing applied) -> PENDING with a fresh budget. */
export async function retryCreditOperation(params: { operationId: string; adminUserId: string }): Promise<CreditAdminResult> {
  return runAsOwner(async (tx) => {
    const op = await tx.affiliateCreditOperation.findUnique({ where: { id: params.operationId }, select: { id: true } });
    if (!op) return { ok: false as const, error: "not_found" as const };
    const { count } = await tx.affiliateCreditOperation.updateMany({
      where: { id: op.id, status: "FAILED" },
      data: { status: "PENDING", attempts: 0, firstProviderAttemptAt: null, lastAttemptAmbiguous: false, nextAttemptAt: new Date(0), lastError: null },
    });
    if (count === 0) return { ok: false as const, error: "invalid_transition" as const };
    return { ok: true as const, value: { id: op.id, status: "PENDING" } };
  });
}

/**
 * ABANDONED, and a person has confirmed in Stripe that the credit DID land:
 * record the transaction id and mark the reward applied. This is the only
 * way an ambiguous ending is resolved - by evidence, never by a retry.
 */
export async function markCreditApplied(params: {
  operationId: string;
  adminUserId: string;
  stripeBalanceTransactionId: string;
  now?: Date;
}): Promise<CreditAdminResult> {
  const now = params.now ?? new Date();
  return runAsOwner(async (tx) => {
    const op = await tx.affiliateCreditOperation.findUnique({
      where: { id: params.operationId },
      select: { id: true, rewardId: true, amountCents: true, appliedCents: true },
    });
    if (!op) return { ok: false as const, error: "not_found" as const };
    const { count } = await tx.affiliateCreditOperation.updateMany({
      where: { id: op.id, status: "ABANDONED" },
      data: {
        status: "APPLIED",
        appliedCents: op.appliedCents ?? op.amountCents,
        appliedAt: now,
        stripeBalanceTransactionId: params.stripeBalanceTransactionId,
        lastError: null,
        lastAttemptAmbiguous: false,
      },
    });
    if (count === 0) return { ok: false as const, error: "invalid_transition" as const };
    const reward = await tx.affiliateReward.findUnique({
      where: { id: op.rewardId },
      select: { referredShopId: true, affiliateAccountId: true, basisPlan: true },
    });
    await tx.affiliateReward.updateMany({ where: { id: op.rewardId, status: "RESERVED" }, data: { status: "APPLIED" } });
    if (reward) {
      await recordAffiliateEvent(tx, {
        shopId: reward.referredShopId,
        accountId: reward.affiliateAccountId,
        type: "credit.adjusted",
        actor: { type: "admin", userId: params.adminUserId },
        metadata: { fromStatus: "ABANDONED", toStatus: "APPLIED", basisPlan: reward.basisPlan },
      });
    }
    return { ok: true as const, value: { id: op.id, status: "APPLIED" } };
  });
}

/**
 * ABANDONED or FAILED, and a person has confirmed in Stripe that NOTHING
 * landed: cancel the operation and hand the reward back to AVAILABLE so the
 * next pass reserves it afresh.
 */
export async function releaseCreditOperation(params: { operationId: string; adminUserId: string }): Promise<CreditAdminResult> {
  return runAsOwner(async (tx) => {
    const op = await tx.affiliateCreditOperation.findUnique({ where: { id: params.operationId }, select: { id: true, rewardId: true } });
    if (!op) return { ok: false as const, error: "not_found" as const };
    const { count } = await tx.affiliateCreditOperation.updateMany({
      where: { id: op.id, status: { in: ["ABANDONED", "FAILED"] } },
      data: { status: "CANCELED", lastError: "released_by_admin", claimedAt: null, claimToken: null, nextAttemptAt: null },
    });
    if (count === 0) return { ok: false as const, error: "invalid_transition" as const };
    await tx.affiliateReward.updateMany({ where: { id: op.rewardId, status: "RESERVED" }, data: { status: "AVAILABLE" } });
    return { ok: true as const, value: { id: op.id, status: "CANCELED" } };
  });
}

export interface AdminCreditRow {
  id: string;
  rewardId: string;
  status: string;
  amountCents: number;
  appliedCents: number | null;
  currency: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAmbiguous: boolean;
  nextAttemptAt: string | null;
  appliedAt: string | null;
  stripeBalanceTransactionId: string | null;
  affiliateShopName: string;
  createdAt: string;
}

export async function listCreditOperations(params: { status?: string }): Promise<AdminCreditRow[]> {
  return runAsOwner(async (tx) => {
    const rows = await tx.affiliateCreditOperation.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      take: 200,
    });
    if (rows.length === 0) return [];
    const shops = await tx.shop.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.shopId))] } },
      select: { id: true, name: true },
    });
    const name = new Map(shops.map((s) => [s.id, s.name] as const));
    return rows.map((r) => ({
      id: r.id,
      rewardId: r.rewardId,
      status: r.status,
      amountCents: r.amountCents,
      appliedCents: r.appliedCents,
      currency: r.currency,
      attempts: r.attempts,
      lastError: r.lastError,
      lastAttemptAmbiguous: r.lastAttemptAmbiguous,
      nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
      appliedAt: r.appliedAt?.toISOString() ?? null,
      stripeBalanceTransactionId: r.stripeBalanceTransactionId,
      affiliateShopName: name.get(r.shopId) ?? "(unknown)",
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/** Referenced so the policy's expiry constant is visibly the one in force. */
export const REWARD_EXPIRY_MONTHS = AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable;
