import { createHash } from "node:crypto";
import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv, decrypt, encrypt, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { NoopMessageProvider, getMessageProvider } from "../messaging/twilio.js";
import { ResendSendError, emailDispatchMode, sendEmail } from "../messaging/email.js";
import { signInEmail, signInSmsBody } from "../services/customerSignInMessage.js";

/** "sms" | "email" - spelled here so the worker needs nothing from the
 *  service that mints challenges (they would otherwise import each other). */
type SignInChannel = "sms" | "email";

/**
 * THE SIGN-IN CODE OUTBOX - the worker that keeps the promise made when a
 * challenge was committed.
 *
 * 🔴 WHY THIS EXISTS. The first cut sent inside `void (async () => ...)`. The
 * code, its five-minute expiry, its 60-second cooldown and its per-day count
 * were all committed; the SEND was a floating promise. A deploy, a crash or a
 * frozen instance in the milliseconds after the response left a customer
 * holding a challenge nobody had been asked to deliver - and a cooldown
 * telling them not to try again yet. That is a locked door, not a delay.
 *
 * The shape is the EmailIntent outbox's, field for field, because this repo
 * should not have two answers to one problem (PR #413 says the same):
 *
 *   - the claim is one atomic conditional UPDATE with a per-pass token, and a
 *     claim older than CLAIM_TTL_MS is treated as abandoned;
 *   - every write after a claim is a compare-and-set ON that token, so a
 *     worker whose rows were taken over writes nothing at all;
 *   - the attempt is reserved, AND MARKED AMBIGUOUS, before the request
 *     leaves - a process that dies after the provider accepted runs none of
 *     the code that would have recorded it, so the fact has to be on disk
 *     before it can happen;
 *   - email retries carry a stable Idempotency-Key, so the PROVIDER collapses
 *     them.
 *
 * ⚠️ SMS IS WEAKER, AND IT IS NAMED RATHER THAN PRETENDED AWAY. Twilio has no
 * idempotency key. A process that dies between "accepted" and "recorded"
 * leaves an attempt that may have been delivered, and the retry may deliver
 * the SAME code a second time. We take that trade deliberately: a sign-in code
 * that never arrives locks somebody out of their own appointments, and a
 * duplicate text of a code they are already typing costs a fraction of a cent
 * and no confusion. What it can NEVER do is produce two codes that both work -
 * a challenge has exactly one live code, and re-issuing supersedes the old
 * delivery in the same transaction that mints the new one.
 */

/** How long a claim is respected before another worker may take the row. */
export const CLAIM_TTL_MS = 90 * 1000;
/** Real provider dispatches permitted. A code only lives five minutes. */
export const MAX_ATTEMPTS = 3;
/** Short, because the whole challenge expires in five minutes. */
const BACKOFF_MS = [15_000, 45_000, 120_000];
/** Bounded per tick so one bad batch cannot monopolise the worker. */
const BATCH = 25;

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
}

/**
 * The key the code and destination are sealed under: derived from the
 * existing secret for THIS purpose only, so a leaked sign-in backup is not
 * also an Acuity token backup.
 */
function sealKey(): string {
  return createHash("sha256")
    .update(`${apiEnv().TOKEN_ENCRYPTION_KEY}:customer_signin_seal_v1`, "utf8")
    .digest("base64");
}

export interface SealedSignIn {
  to: string;
  code: string;
}

export function sealSignIn(payload: SealedSignIn): string {
  return encrypt(JSON.stringify(payload), sealKey());
}

function openSealed(sealed: string): SealedSignIn | null {
  try {
    const parsed = JSON.parse(decrypt(sealed, sealKey())) as SealedSignIn;
    return typeof parsed?.to === "string" && typeof parsed?.code === "string" ? parsed : null;
  } catch {
    // A key rotation, or a corrupt row. Never retryable, never loggable.
    return null;
  }
}

export type DeliveryOutcome =
  | "sent"
  | "retry"
  | "failed"
  | "abandoned"
  | "suppressed"
  | "expired"
  | "stale_claim"
  | "not_found";

export interface SignInOutboxResult {
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  abandoned: number;
  suppressed: number;
  expired: number;
  staleClaim: number;
}

const EMPTY: SignInOutboxResult = {
  claimed: 0,
  sent: 0,
  retry: 0,
  failed: 0,
  abandoned: 0,
  suppressed: 0,
  expired: 0,
  staleClaim: 0,
};

function tally(result: SignInOutboxResult, outcome: DeliveryOutcome): void {
  if (outcome === "sent") result.sent++;
  else if (outcome === "retry") result.retry++;
  else if (outcome === "failed") result.failed++;
  else if (outcome === "abandoned") result.abandoned++;
  else if (outcome === "suppressed") result.suppressed++;
  else if (outcome === "expired") result.expired++;
  else if (outcome === "stale_claim") result.staleClaim++;
}

/**
 * Claim up to `batch` due deliveries and attempt each. Runs on the scheduler
 * every minute AND is what makes the immediate in-process kick optional
 * rather than load-bearing.
 */
export async function runCustomerSignInOutbox(
  opts: { now?: Date; batch?: number } = {},
): Promise<SignInOutboxResult> {
  const now = opts.now ?? new Date();
  // Inlined as a validated integer, never a bound parameter: PR #413 found a
  // LIMIT that bound as a parameter and was then not applied at all.
  const batch = Math.max(1, Math.min(Math.trunc(opts.batch ?? BATCH), 200));
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const claimToken = randomToken(16);

  const claimed = await runAsOwner((tx) =>
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "CustomerSignInDelivery"
         SET "claimedAt" = ${now.toISOString()}::timestamp,
             "claimToken" = ${claimToken},
             "updatedAt" = now()
       WHERE "id" IN (
         SELECT "id" FROM "CustomerSignInDelivery"
          WHERE "status" = 'pending'
            AND ("nextAttemptAt" IS NULL
                 OR "nextAttemptAt" <= ${now.toISOString()}::timestamp)
            AND ("claimedAt" IS NULL
                 OR "claimedAt" < ${staleBefore.toISOString()}::timestamp)
          ORDER BY "nextAttemptAt" NULLS FIRST, "createdAt"
          LIMIT ${Prisma.raw(String(batch))}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING "id"`),
  );

  const result: SignInOutboxResult = { ...EMPTY, claimed: claimed.length };
  for (const row of claimed) {
    const outcome = await deliverSignInCode({ deliveryId: row.id, claimToken, now }).catch(
      () => "retry" as const,
    );
    tally(result, outcome);
  }
  if (result.sent > 0 || result.failed > 0 || result.abandoned > 0 || result.expired > 0) {
    logger.info(result, "customer sign-in outbox drained");
  }
  return result;
}

/**
 * The fast path: deliver ONE delivery immediately after its transaction
 * commits, so a code arrives in seconds rather than on the next minute's tick.
 *
 * Best-effort by construction - it takes the same claim, makes the same
 * compare-and-set writes, and if this process dies the sweeper above picks the
 * row up once the claim ages out. Never throws: the caller has already
 * answered the customer.
 */
export async function kickSignInDelivery(deliveryId: string, now = new Date()): Promise<void> {
  const claimToken = randomToken(16);
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  try {
    const claimed = await runAsOwner((tx) =>
      tx.$executeRaw(Prisma.sql`
        UPDATE "CustomerSignInDelivery"
           SET "claimedAt" = ${now.toISOString()}::timestamp,
               "claimToken" = ${claimToken},
               "updatedAt" = now()
         WHERE "id" = ${deliveryId}
           AND "status" = 'pending'
           AND ("claimedAt" IS NULL
                OR "claimedAt" < ${staleBefore.toISOString()}::timestamp)`),
    );
    if (claimed === 0) return;
    await deliverSignInCode({ deliveryId, claimToken, now });
  } catch {
    // Fixed classification only, and not even that: the sweeper will say so.
    logger.warn({ deliveryId }, "customer sign-in: immediate delivery failed");
  }
}

interface DeliveryRow {
  id: string;
  channel: string;
  sealed: string | null;
  attempts: number;
  expiresAt: Date;
  idempotencyKey: string;
}

/** Settle a delivery, but ONLY if this worker still holds the claim. */
async function settle(
  deliveryId: string,
  claimToken: string,
  data: Prisma.CustomerSignInDeliveryUpdateManyMutationInput,
): Promise<boolean> {
  const changed = await runAsOwner((tx) =>
    tx.customerSignInDelivery.updateMany({
      where: { id: deliveryId, status: "pending", claimToken },
      data,
    }),
  );
  return changed.count > 0;
}

/**
 * Render and send ONE claimed delivery.
 *
 * Everything above the RESERVE line is durable and repeatable; everything
 * below it may never run, because the process can die at any point from there.
 */
export async function deliverSignInCode(params: {
  deliveryId: string;
  claimToken: string;
  now?: Date;
}): Promise<DeliveryOutcome> {
  const now = params.now ?? new Date();
  const row = await runAsOwner((tx) =>
    tx.customerSignInDelivery.findFirst({
      where: { id: params.deliveryId, status: "pending", claimToken: params.claimToken },
      select: {
        id: true,
        channel: true,
        sealed: true,
        attempts: true,
        expiresAt: true,
        idempotencyKey: true,
      },
    }),
  );
  if (!row) return "stale_claim";
  const delivery = row as DeliveryRow;

  // The challenge is dead: nothing to deliver, and the code is wiped with it.
  if (delivery.expiresAt.getTime() <= now.getTime()) {
    await settle(delivery.id, params.claimToken, {
      status: "expired",
      sealed: null,
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
    });
    return "expired";
  }

  const payload = delivery.sealed ? openSealed(delivery.sealed) : null;
  if (!payload) {
    await settle(delivery.id, params.claimToken, {
      status: "failed",
      sealed: null,
      lastError: "unreadable",
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
    });
    return "failed";
  }

  const channel = delivery.channel as SignInChannel;

  // Decided BEFORE an attempt is counted: a send that can never reach a
  // provider must not spend the attempt budget. Terminal, like the email
  // outbox's SUPPRESSED - a switched-off channel is not a transient fault.
  const provider = channel === "sms" ? getMessageProvider() : null;
  const suppressed =
    channel === "sms" ? provider instanceof NoopMessageProvider : emailDispatchMode() !== "live";
  if (suppressed) {
    await settle(delivery.id, params.claimToken, {
      status: "suppressed",
      sealed: null,
      lastError: channel === "sms" ? "dry_run" : emailDispatchMode(),
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
    });
    return "suppressed";
  }

  // 🔴 RESERVE THE ATTEMPT, AND WRITE THE AMBIGUITY AHEAD OF IT. One
  // statement: the compare-and-set on the claim, the ceiling, the increment,
  // the refreshed claim (so this row's own TTL starts now, not when the batch
  // did) and the write-ahead marker. It commits before the request leaves.
  const reserved = await runAsOwner((tx) =>
    tx.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      UPDATE "CustomerSignInDelivery"
         SET "attempts" = "attempts" + 1,
             "firstProviderAttemptAt" =
               COALESCE("firstProviderAttemptAt", ${now.toISOString()}::timestamp),
             "lastAttemptAmbiguous" = true,
             "claimedAt" = ${now.toISOString()}::timestamp,
             "updatedAt" = now()
       WHERE "id" = ${delivery.id}
         AND "status" = 'pending'
         AND "claimToken" = ${params.claimToken}
         AND "attempts" < ${MAX_ATTEMPTS}
      RETURNING "attempts"`),
  );
  const attemptNo = reserved[0]?.attempts;
  if (attemptNo === undefined) {
    // Either the claim was taken over, or the budget is spent. Only the
    // second is ours to settle.
    const spent = await settle(delivery.id, params.claimToken, {
      status: "abandoned",
      sealed: null,
      lastError: "attempts_exhausted",
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
    });
    return spent ? "abandoned" : "stale_claim";
  }

  // ---- THE BOUNDARY ------------------------------------------------------
  try {
    if (channel === "sms") {
      const sent = await getMessageProvider().send({
        to: payload.to,
        body: signInSmsBody(payload.code),
      });
      return await recordSent(delivery, params.claimToken, now, sent.sid);
    }
    const mail = signInEmail(payload.code);
    const sent = await sendEmail({
      to: payload.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // The PROVIDER-side exactly-once guard for the channel that has one.
      idempotencyKey: delivery.idempotencyKey,
      meta: { kind: "customer_sign_in" },
    });
    if (sent.status !== "sent" || !sent.id || sent.id === "unknown") {
      return await backOffOrGiveUp(delivery, params.claimToken, now, attemptNo, {
        ambiguous: true,
        error: "no_message_id",
      });
    }
    return await recordSent(delivery, params.claimToken, now, sent.id);
  } catch (err) {
    // 🔴 Fixed classification only. The thrown value may carry the phone, the
    // address, the code, the body or a provider credential.
    const definitive = classify(err);
    return await backOffOrGiveUp(delivery, params.claimToken, now, attemptNo, {
      ambiguous: definitive === null,
      error: definitive ?? "transport_error",
    });
  }
}

/**
 * Did the provider LOOK at it and refuse (nothing was accepted, a retry
 * cannot duplicate), or did the transport die with the answer unknown?
 */
function classify(err: unknown): string | null {
  if (err instanceof ResendSendError) return err.classification;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return status === 429 ? "rate_limited" : status < 500 ? "rejected" : "provider_error";
  }
  return null;
}

async function recordSent(
  delivery: DeliveryRow,
  claimToken: string,
  now: Date,
  messageId: string | undefined,
): Promise<DeliveryOutcome> {
  const ok = await settle(delivery.id, claimToken, {
    status: "sent",
    sentAt: now,
    providerMessageId: messageId ?? null,
    // Confirmed acceptance is one of the two things that may clear the marker.
    lastAttemptAmbiguous: false,
    lastError: null,
    sealed: null,
    claimedAt: null,
    claimToken: null,
    nextAttemptAt: null,
  });
  return ok ? "sent" : "stale_claim";
}

async function backOffOrGiveUp(
  delivery: DeliveryRow,
  claimToken: string,
  now: Date,
  attemptNo: number,
  outcome: { ambiguous: boolean; error: string },
): Promise<DeliveryOutcome> {
  const exhausted = attemptNo >= MAX_ATTEMPTS;
  // 🔴 FIXED FIELDS ONLY. Not the destination, not the code, not the
  // provider's own message - a thrown provider error routinely carries all
  // three, plus an API credential.
  logger.warn(
    { channel: delivery.channel, attempt: attemptNo, reason: outcome.error, exhausted },
    "customer sign-in: code delivery attempt failed",
  );
  if (exhausted) {
    const ok = await settle(delivery.id, claimToken, {
      // A definitive refusal never delivered anything; an ambiguous one may
      // have. The two are not the same fact and are not stored as one.
      status: outcome.ambiguous ? "abandoned" : "failed",
      sealed: null,
      lastError: outcome.error,
      lastAttemptAmbiguous: outcome.ambiguous,
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
    });
    return ok ? (outcome.ambiguous ? "abandoned" : "failed") : "stale_claim";
  }
  const ok = await settle(delivery.id, claimToken, {
    lastError: outcome.error,
    lastAttemptAmbiguous: outcome.ambiguous,
    nextAttemptAt: new Date(now.getTime() + backoffFor(attemptNo)),
    claimedAt: null,
    claimToken: null,
  });
  return ok ? "retry" : "stale_claim";
}
