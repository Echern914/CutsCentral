import { randomToken } from "@chairback/config";
import { Prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import {
  deliverCancellationIntent,
  settle,
  type IntentOutcome,
} from "../services/appointmentCanceledNotify.js";
import { deliverAffiliateIntent, isAffiliateEmailKind } from "../services/affiliateNotify.js";
import {
  deliverTipReceiptIntent,
  deliverTipRequestIntent,
  isTipReceiptKind,
  isTipRequestKind,
} from "../services/tipEmails.js";
import {
  deliverGroupConfirmationIntent,
  isGroupConfirmationKind,
} from "./appointmentGroupSettle.js";
import {
  deliverServiceChargeReceiptIntent,
  isServiceChargeReceiptKind,
} from "../services/serviceChargeReceipt.js";

/**
 * The email outbox worker: drains PENDING EmailIntent rows.
 *
 * The intent was committed with the cancellation itself, so by the time this
 * runs the promise to email somebody is already durable. All this does is
 * keep that promise, in bounded batches, with at most one replica working a
 * given row.
 *
 * CLAIMING is an atomic conditional UPDATE, the same primitive the scheduler
 * lease uses. A claim older than CLAIM_TTL_MS is treated as abandoned - that
 * is what makes "the process died after claiming but before the HTTP request"
 * recoverable rather than a stuck row.
 */

/** How long a claim is respected before another worker may take the row. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;
/** Bounded per tick so one bad batch cannot monopolise a worker. */
const BATCH = 25;

export interface OutboxResult {
  claimed: number;
  sent: number;
  retry: number;
  abandoned: number;
  suppressed: number;
  superseded: number;
  /** Rows whose claim was taken over before we could attempt them. */
  staleClaim: number;
}

/**
 * Claim up to `batch` due intents and attempt each.
 *
 * `now` is a parameter everywhere so a test can age a claim or cross the
 * provider idempotency window without sleeping.
 *
 * `shopId` is for TESTS ONLY. EmailIntent has no foreign key to Shop, so a
 * PENDING intent another suite left behind outlives its shop, and an unscoped
 * test drain spends its batch on those leftovers before reaching its own row.
 * The scheduler calls this with NO arguments (scheduler.emailOutboxScope.test.ts
 * pins it): production always drains every shop.
 */
export async function runEmailOutbox(
  opts: { now?: Date; batch?: number; shopId?: string } = {},
): Promise<OutboxResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? BATCH;
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  // 🔴 THE IDENTITY OF THIS CLAIM. Every attempt reservation compare-and-sets
  // on it, so a worker that stalled past the TTL and had its rows taken over
  // cannot wake up and spend a provider attempt on a row it no longer holds.
  // A fresh token per pass is what makes "taken over" detectable at all.
  const claimToken = randomToken(16);

  // One statement claims the rows: PENDING and either unclaimed or claimed so
  // long ago the holder must be gone. Doing it in SQL keeps the check and the
  // write atomic, so two replicas cannot both take the same row.
  // 🔴 THE CLAIM DOES NOT COUNT AS AN ATTEMPT. `attempts` is incremented only
  // immediately before a real Resend request (see deliverCancellationIntent) -
  // otherwise a worker that crashed five times before ever dispatching would
  // exhaust the budget without the provider having been contacted once.
  //
  // `nextAttemptAt` is the backoff gate: a row rejected with a 429 or a 5xx
  // comes back due later rather than being hammered every minute.
  //
  // 🔴 The locked sub-select is a MATERIALIZED CTE so it runs exactly once:
  // as `WHERE "id" IN (... LIMIT n FOR UPDATE SKIP LOCKED)` a nested-loop plan
  // re-runs it per row and claims past its LIMIT (#445, broadcastWorker.ts
  // claimDueSends). claimShape.test.ts keeps that shape out.
  const claimed = await runAsOwner((tx) =>
    tx.$queryRaw<{ id: string; kind: string }[]>(Prisma.sql`
      WITH due AS MATERIALIZED (
        SELECT "id" FROM "EmailIntent"
         WHERE "status" = 'PENDING'
           ${opts.shopId ? Prisma.sql`AND "shopId" = ${opts.shopId}` : Prisma.empty}
           AND ("nextAttemptAt" IS NULL
                OR "nextAttemptAt" <= ${now.toISOString()}::timestamp)
           AND ("claimedAt" IS NULL OR "claimedAt" < ${staleBefore.toISOString()}::timestamp)
         ORDER BY "nextAttemptAt" NULLS FIRST, "createdAt"
         LIMIT ${batch}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "EmailIntent" t
         SET "claimedAt" = ${now.toISOString()}::timestamp,
             "claimToken" = ${claimToken},
             "updatedAt" = now()
        FROM due
       WHERE t."id" = due."id"
      RETURNING t."id", t."kind"`),
  );

  const result: OutboxResult = {
    claimed: claimed.length,
    sent: 0,
    retry: 0,
    abandoned: 0,
    suppressed: 0,
    superseded: 0,
    staleClaim: 0,
  };

  for (const row of claimed) {
    // Never throws: deliver* classifies every failure itself. A single bad
    // intent must not stop the batch.
    // One outbox, several families of email. The kind on the row picks the
    // deliverer; all of them share the claim/attempt/idempotency state machine,
    // which is the whole reason each new email rides here rather than getting
    // a delivery path of its own.
    const deliver = deliveryFor(row.kind);
    if (!deliver) {
      // 🔴 NEVER A SILENT FALLTHROUGH. An unrouted kind used to land on the
      // cancellation deliverer, which settles anything not cancelled as
      // SUPERSEDED - a new email that was never wired in vanished without a
      // trace. Now it fails loudly, in the ledger and the log.
      logger.error({ kind: row.kind, intentId: row.id }, "email outbox: no deliverer for this kind");
      await settle(row.id, "FAILED", "unknown_kind");
      continue;
    }
    const outcome = await deliver({
      intentId: row.id,
      claimToken,
      now,
    }).catch(() => "retry" as const);
    if (outcome === "sent") result.sent++;
    else if (outcome === "retry") result.retry++;
    else if (outcome === "abandoned") result.abandoned++;
    else if (outcome === "suppressed") result.suppressed++;
    else if (outcome === "superseded") result.superseded++;
    else if (outcome === "stale_claim") result.staleClaim++;
  }

  if (result.sent > 0 || result.abandoned > 0) {
    logger.info(result, "email outbox drained");
  }
  return result;
}

type Deliverer = (params: { intentId: string; claimToken: string; now?: Date }) => Promise<IntentOutcome>;

/** The deliverer for one EmailIntent kind, or null for a kind nothing sends. */
export function deliveryFor(kind: string): Deliverer | null {
  if (kind === "appointment_canceled") return deliverCancellationIntent;
  if (isGroupConfirmationKind(kind)) return deliverGroupConfirmationIntent;
  if (isServiceChargeReceiptKind(kind)) return deliverServiceChargeReceiptIntent;
  if (isAffiliateEmailKind(kind)) return deliverAffiliateIntent;
  if (isTipRequestKind(kind)) return deliverTipRequestIntent;
  if (isTipReceiptKind(kind)) return deliverTipReceiptIntent;
  return null;
}
