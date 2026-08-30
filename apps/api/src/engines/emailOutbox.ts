import { Prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { deliverCancellationIntent } from "../services/appointmentCanceledNotify.js";

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
}

/**
 * Claim up to `batch` due intents and attempt each.
 *
 * `now` is a parameter everywhere so a test can age a claim or cross the
 * provider idempotency window without sleeping.
 */
export async function runEmailOutbox(
  opts: { now?: Date; batch?: number } = {},
): Promise<OutboxResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? BATCH;
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);

  // One statement claims the rows: PENDING and either unclaimed or claimed so
  // long ago the holder must be gone. Doing it in SQL keeps the check and the
  // write atomic, so two replicas cannot both take the same row.
  const claimed = await runAsOwner((tx) =>
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "EmailIntent"
         SET "claimedAt" = ${now.toISOString()}::timestamp,
             "attempts" = "attempts" + 1,
             "updatedAt" = now()
       WHERE "id" IN (
         SELECT "id" FROM "EmailIntent"
          WHERE "status" = 'PENDING'
            AND ("claimedAt" IS NULL OR "claimedAt" < ${staleBefore.toISOString()}::timestamp)
          ORDER BY "createdAt"
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING "id"`),
  );

  const result: OutboxResult = {
    claimed: claimed.length,
    sent: 0,
    retry: 0,
    abandoned: 0,
  };

  for (const row of claimed) {
    // Never throws: deliver* classifies every failure itself. A single bad
    // intent must not stop the batch.
    const outcome = await deliverCancellationIntent({ intentId: row.id, now }).catch(
      () => "retry" as const,
    );
    if (outcome === "sent") result.sent++;
    else if (outcome === "retry") result.retry++;
    else if (outcome === "abandoned") result.abandoned++;
  }

  if (result.sent > 0 || result.abandoned > 0) {
    logger.info(result, "email outbox drained");
  }
  return result;
}
