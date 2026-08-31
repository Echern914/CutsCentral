import { Prisma, runAsOwner } from "@chairback/db";
import { buildAppointmentCanceledEmail } from "../messaging/templates.js";
import {
  emailDispatchMode,
  ResendSendError,
  sendEmail,
} from "../messaging/email.js";
import { logger } from "../logger.js";

/**
 * "Your appointment was canceled" - the email a ChairBack customer never used
 * to receive on any path.
 *
 * 🔴 A DURABLE OUTBOX, NOT A STAMP.
 *
 * The first cut claimed `cancellationEmailSentAt` and then called Resend. A
 * crash, deploy, timeout or process exit between those two steps left the
 * appointment recording that the customer had been told while nothing had
 * been sent and nothing would ever retry - the failure mode is silent and
 * permanent, which is the worst shape a notification bug can take.
 *
 * Now: `enqueueCancellationEmail` writes a PENDING EmailIntent INSIDE the
 * cancellation transaction, so the promise to email is exactly as durable as
 * the cancellation itself and can neither precede it nor outlive its rollback.
 * A lease-guarded worker (engines/emailOutbox.ts) drains the queue afterwards.
 * Resend is never called inside the transaction.
 *
 * EXACTLY-ONCE comes from two independent mechanisms:
 *  1. `idempotencyKey` is UNIQUE, so concurrent cancels of the same
 *     occurrence create ONE intent.
 *  2. That same key is sent as Resend's `Idempotency-Key` header, so a retry
 *     after an ambiguous attempt is collapsed by the PROVIDER rather than by
 *     our guess about whether the first attempt landed.
 *
 * The key is per CANCELLATION OCCURRENCE, not per appointment: restore →
 * cancel again is genuinely a new notification and must produce a new email.
 */

/** Statuses whose cancellation is worth telling the customer about. */
const NOTIFIABLE = new Set(["CANCELED"]);

/**
 * One cancellation occurrence's key. `canceledAt` is what changes between a
 * first cancel and a post-restore second cancel, so it - not the appointment
 * id alone - is what makes the two distinct.
 */
export function cancellationIdempotencyKey(
  appointmentId: string,
  cancellationRevision: number,
): string {
  return `cancel:${appointmentId}:r${cancellationRevision}`;
}

/**
 * Enqueue the cancellation email. MUST be called with the transaction that is
 * cancelling the appointment, so the two commit or roll back together.
 *
 * Returns the intent's idempotency key, or null when there is nothing to send
 * (no address, or an appointment that is not actually being canceled).
 */
export async function enqueueCancellationEmail(
  tx: Prisma.TransactionClient,
  params: { shopId: string; appointmentId: string; cancellationRevision: number },
): Promise<string | null> {
  const appt = await tx.appointment.findFirst({
    where: { id: params.appointmentId, shopId: params.shopId },
    select: {
      id: true,
      email: true,
      client: { select: { email: true } },
    },
  });
  if (!appt) return null;
  // No address is not a failure - there is simply nobody to write to.
  if (!(appt.email ?? appt.client?.email)) return null;

  // Keyed on the REVISION the winning transition produced, so the key names a
  // cancellation that actually happened. Two concurrent requests can no
  // longer mint two keys, because only one of them wins the transition at all.
  const idempotencyKey = cancellationIdempotencyKey(
    appt.id,
    params.cancellationRevision,
  );
  await tx.emailIntent.createMany({
    data: [
      {
        kind: "appointment_canceled",
        idempotencyKey,
        shopId: params.shopId,
        appointmentId: appt.id,
        cancellationRevision: params.cancellationRevision,
        status: "PENDING",
        nextAttemptAt: new Date(0), // due immediately
      },
    ],
    skipDuplicates: true, // belt: the unique index is the real guarantee
  });
  return idempotencyKey;
}

export type IntentOutcome =
  | "sent"
  | "skipped"
  | "retry"
  | "abandoned"
  | "suppressed"
  | "superseded"
  /** Our claim was replaced while we held it - another worker owns this row. */
  | "stale_claim"
  | "not_found";

/**
 * Resend honours an Idempotency-Key for 24 HOURS FROM THE FIRST REQUEST that
 * carried it. Measuring from row creation was wrong: an intent can sit for
 * days while email is unconfigured without ever having been put in front of
 * the provider, and its safety window has not started, let alone expired.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Real provider dispatches permitted - claims and suppressions are not attempts. */
export const MAX_ATTEMPTS = 5;
/** Bounded exponential backoff: ~1m, 5m, 25m, capped. */
const BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 60 * 60_000, 60 * 60_000];

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
}

/**
 * Render and send ONE claimed intent.
 *
 * The state machine distinguishes three genuinely different failures, because
 * conflating them is how customers get told twice or never told at all:
 *
 *   SUPPRESSED  email is unconfigured, or DRY_RUN is on. Nothing was sent and
 *               nothing will be. TERMINAL on purpose - keeping it PENDING
 *               means switching email on next month blasts everyone whose
 *               cancellation was silently swallowed weeks ago.
 *   FAILED      the provider DEFINITIVELY rejected it (an HTTP error). It was
 *               not accepted, so a retry cannot duplicate; retry with backoff
 *               up to MAX_ATTEMPTS, then give up.
 *   ABANDONED   the outcome was AMBIGUOUS (transport died, or a 2xx with no
 *               message id) and we can no longer retry safely - the provider's
 *               idempotency window has closed, or the attempt budget is spent.
 *               A retry might deliver a SECOND copy. Terminal and visible.
 *
 * 🔴 THE EXPIRY CHECK HAPPENS BEFORE THE REQUEST, NOT AFTER IT. Asking "is the
 * key still honoured?" inside the ambiguous handler asked it one HTTP call too
 * late: the second request had already gone, and if the first had in fact been
 * accepted the customer got the same email twice. `lastAttemptAmbiguous` is
 * persisted precisely so the question can be answered before dispatching.
 */
export async function deliverCancellationIntent(params: {
  intentId: string;
  /**
   * The token written by the claim that handed us this row. Every attempt
   * reservation is a compare-and-set on it, so a worker whose claim aged out
   * and was taken over cannot spend a provider attempt on a row it no longer
   * holds.
   */
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findUnique({ where: { id: params.intentId } }),
  );
  if (!intent || !intent.appointmentId) return "not_found";

  const appt = await runAsOwner((tx) =>
    tx.appointment.findFirst({
      where: { id: intent.appointmentId!, shopId: intent.shopId },
      select: {
        id: true,
        status: true,
        cancellationRevision: true,
        startsAt: true,
        firstName: true,
        email: true,
        client: { select: { email: true, firstName: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
        shop: { select: { name: true, slug: true, timezone: true } },
      },
    }),
  );

  // 🔴 BOTH GUARDS, immediately before dispatch. Status alone is not enough:
  // after cancel -> restore -> cancel the appointment IS canceled again, and a
  // stale intent from the first occurrence would happily send beside the new
  // one. The revision is what makes "this cancellation" a specific event.
  if (
    !appt ||
    !NOTIFIABLE.has(appt.status) ||
    (intent.cancellationRevision !== null &&
      intent.cancellationRevision !== appt.cancellationRevision)
  ) {
    await settle(params.intentId, "SUPERSEDED", "superseded");
    return "superseded";
  }

  // 🔴 THE EXPIRED-AMBIGUOUS GUARD, and it must come before EVERYTHING that
  // could dispatch. The previous attempt may already have been accepted; past
  // the provider's window the Idempotency-Key means nothing, so a fresh
  // request is a fresh email. One atomic transition, zero provider calls.
  //
  // A DEFINITIVE rejection deliberately does not qualify: Resend looked at it
  // and refused, so nothing was accepted and a retry cannot duplicate however
  // long has passed. That is exactly what `lastAttemptAmbiguous` distinguishes.
  const expired = await runAsOwner((tx) =>
    tx.emailIntent.updateMany({
      where: {
        id: params.intentId,
        status: "PENDING",
        claimToken: params.claimToken,
        lastAttemptAmbiguous: true,
        firstProviderAttemptAt: {
          lte: new Date(now.getTime() - PROVIDER_IDEMPOTENCY_WINDOW_MS),
        },
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
      { intentId: params.intentId, reason: "idempotency_window_expired" },
      "cancellation email abandoned unsent - an earlier attempt may already have been delivered",
    );
    return "abandoned";
  }

  const to = appt.email ?? appt.client?.email ?? null;
  if (!to) {
    await settle(params.intentId, "FAILED", "no_address");
    return "skipped";
  }

  // Decided BEFORE the attempt is counted: a send that never reaches a
  // provider must not consume the provider budget. Terminal on purpose - see
  // SUPPRESSED in the header.
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(params.intentId, "SUPPRESSED", mode);
    return "suppressed";
  }

  const email = buildAppointmentCanceledEmail({
    firstName: appt.firstName ?? appt.client?.firstName ?? null,
    shopName: appt.shop.name,
    shopSlug: appt.shop.slug,
    serviceName: appt.service?.name ?? "your appointment",
    startsAt: appt.startsAt,
    timezone: appt.shop.timezone,
    staffName: appt.staff?.name ?? null,
  });

  // 🔴 RESERVE THE ATTEMPT ATOMICALLY, AND WRITE THE AMBIGUITY AHEAD OF IT.
  //
  // The number comes back from the database's own increment, not from the
  // `attempts` we read moments ago: two workers reading 2 and both writing 3
  // is a lost increment, and a lost increment is an extra provider call the
  // budget never accounted for.
  //
  // This transaction COMMITS before the line below runs, so the row already
  // says "an attempt may be in flight" when the request leaves. See
  // reserveAttempt for why that ordering is the whole guarantee.
  const attemptNo = await reserveAttempt(params.intentId, params.claimToken, now);
  if (attemptNo === null) return await classifyRefusedReservation(params, now);

  // ---- THE BOUNDARY. Everything above is durable; everything below may
  // ---- never run, because the process can die at any point from here.
  try {
    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: appt.shop.name,
      stream: "transactional",
      // The PROVIDER-side exactly-once guard: Resend collapses repeat attempts
      // carrying the same key, so retrying an ambiguous send cannot deliver
      // twice - within its window.
      idempotencyKey: intent.idempotencyKey,
      meta: { shopId: intent.shopId, appointmentId: appt.id, kind: "cancellation" },
    });

    // A 2xx with no message id is NOT confirmed acceptance - there is nothing
    // to correlate a delivery event to, so treat it as ambiguous rather than
    // stamping the appointment on a shrug.
    if (result.status !== "sent" || !result.id || result.id === "unknown") {
      return ambiguous(params.intentId, attemptNo, now, "no_message_id");
    }

    // 🔴 ONE TRANSACTION settles everything: the intent, the appointment stamp
    // and the delivery ledger row carrying the provider id. Leaving the ledger
    // to the fire-and-forget metadata write meant a crash here could stamp the
    // appointment while nothing recorded which message did it.
    await runAsOwner(async (tx) => {
      await tx.emailIntent.update({
        where: { id: params.intentId },
        data: {
          status: "SENT",
          sentAt: now,
          messageId: result.id,
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
          lastError: null,
          // Confirmed acceptance - the only thing besides a definitive
          // rejection that may clear the ambiguity marker.
          lastAttemptAmbiguous: false,
        },
      });
      // Only NOW: the stamp records provider acceptance, nothing sooner.
      await tx.appointment.updateMany({
        where: { id: appt.id, shopId: intent.shopId },
        data: { cancellationEmailSentAt: now },
      });
      // Upsert, not create: a webhook may already have created this row from
      // an event that beat us here, and its status must survive.
      await tx.emailDelivery.upsert({
        where: { messageId: result.id },
        create: {
          messageId: result.id,
          kind: "cancellation",
          shopId: intent.shopId,
          appointmentId: appt.id,
          status: "sent",
        },
        update: {
          kind: "cancellation",
          shopId: intent.shopId,
          appointmentId: appt.id,
          awaitingDispatchMeta: false,
        },
      });
    });
    return "sent";
  } catch (err) {
    if (err instanceof ResendSendError) {
      // DEFINITIVE rejection: Resend looked at it and said no, so nothing was
      // accepted and a retry cannot duplicate. This is never "ambiguous".
      return definitiveFailure(params.intentId, attemptNo, err.classification, now);
    }
    // Transport died mid-flight - or the bounded fetch timeout fired - so it
    // may or may not have been accepted.
    return ambiguous(params.intentId, attemptNo, now, "transport_error");
  }
}

/**
 * Take the next attempt number, or refuse.
 *
 * 🔴 THIS IS A WRITE-AHEAD RECORD, NOT A COUNTER.
 *
 * One statement does four jobs - the compare-and-set on the claim token, the
 * ceiling, the increment, and marking the attempt AMBIGUOUS BEFORE IT HAPPENS -
 * and it runs in its own transaction, which commits when this function returns.
 * `sendEmail` is called strictly afterwards, so the first byte of the Resend
 * request cannot leave until "an attempt may be in flight" is durable.
 *
 * Writing the ambiguity only after a timeout or a caught error would leave a
 * window with no correct outcome: a process that dies AFTER Resend accepts the
 * message but BEFORE the response is processed runs none of that code, so the
 * row would still read `lastAttemptAmbiguous = false` - "safe to retry" - and
 * the retry past the 24h window would deliver a SECOND cancellation email.
 * There is no way to observe that crash after the fact, so the fact has to be
 * on disk before it can happen.
 *
 * The cost is deliberate and accepted: a crash between this commit and the
 * request actually being made leaves a row that may eventually be ABANDONED
 * unsent. An email that never arrives is a worse outcome than one that does,
 * but a DUPLICATE cancellation - telling a customer twice that an appointment
 * they may have already rebooked was canceled - is worse than both.
 *
 * The marker is cleared only by a DEFINITIVE answer: acceptance (settle SENT)
 * or an explicit provider rejection (`definitiveFailure`).
 *
 * Returns the number the DATABASE assigned, or null when this worker may not
 * attempt at all.
 */
async function reserveAttempt(
  intentId: string,
  claimToken: string,
  now: Date,
): Promise<number | null> {
  const rows = await runAsOwner((tx) =>
    // 🔴 ISO string + ::timestamp, never a JS Date in raw SQL - a Date is
    // serialised with a timezone and lands an hour out.
    tx.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      UPDATE "EmailIntent"
         SET "attempts" = "attempts" + 1,
             "firstProviderAttemptAt" =
               COALESCE("firstProviderAttemptAt", ${now.toISOString()}::timestamp),
             "lastAttemptAmbiguous" = true,
             "updatedAt" = now()
       WHERE "id" = ${intentId}
         AND "status" = 'PENDING'
         AND "claimToken" = ${claimToken}
         AND "attempts" < ${MAX_ATTEMPTS}
      RETURNING "attempts"`),
  );
  return rows[0] ? Number(rows[0].attempts) : null;
}

/**
 * The reservation was refused. Say WHY, because the three reasons want
 * different endings and only one of them is a failure.
 */
async function classifyRefusedReservation(
  params: { intentId: string; claimToken: string },
  now: Date,
): Promise<IntentOutcome> {
  const row = await runAsOwner((tx) =>
    tx.emailIntent.findUnique({
      where: { id: params.intentId },
      select: { status: true, claimToken: true, lastAttemptAmbiguous: true },
    }),
  );
  if (!row) return "not_found";
  // Somebody else already settled it - nothing to do and nothing to report.
  if (row.status !== "PENDING") return "skipped";
  // 🔴 Our claim was replaced while we held it. The row belongs to another
  // worker now; touching it would be exactly the double-send this guard
  // exists to prevent.
  if (row.claimToken !== params.claimToken) return "stale_claim";
  // The budget is spent. ABANDONED, not FAILED, when the last thing we know
  // is an ambiguous attempt: "we stopped without knowing" is the truth, and
  // recording "it failed" would claim more than we can support.
  const status = row.lastAttemptAmbiguous ? "ABANDONED" : "FAILED";
  await settle(params.intentId, status, "max_attempts");
  logger.error(
    { intentId: params.intentId, reason: "max_attempts", outcome: status },
    "cancellation email gave up - attempt budget exhausted",
  );
  return row.lastAttemptAmbiguous ? "abandoned" : "skipped";
}

/**
 * Rejected outright: safe to retry, bounded by MAX_ATTEMPTS - and safe to
 * retry LATER THAN THE IDEMPOTENCY WINDOW too, which is why this clears the
 * ambiguity marker. Nothing was accepted, so nothing can be duplicated.
 */
async function definitiveFailure(
  intentId: string,
  attemptNo: number,
  classification: string,
  now: Date,
): Promise<IntentOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    await settle(intentId, "FAILED", classification, { ambiguous: false });
    logger.error(
      { intentId, reason: classification, attempts: attemptNo },
      "cancellation email rejected by provider, giving up",
    );
    return "skipped";
  }
  await release(intentId, classification, new Date(now.getTime() + backoffFor(attemptNo)), {
    ambiguous: false,
  });
  return "retry";
}

/**
 * Might already have been delivered. Retrying is safe only while the provider
 * still collapses repeats of this key - a window that opened at the FIRST
 * attempt, so it is read from the row rather than guessed.
 *
 * The marker is already true (reserveAttempt wrote it ahead of the request);
 * this path LEAVES IT TRUE, which is the whole point. Writing it here would be
 * too late for the crash-after-acceptance case, so this is a restatement, not
 * the mechanism.
 */
async function ambiguous(
  intentId: string,
  attemptNo: number,
  now: Date,
  classification: string,
): Promise<IntentOutcome> {
  const row = await runAsOwner((tx) =>
    tx.emailIntent.findUnique({
      where: { id: intentId },
      select: { firstProviderAttemptAt: true },
    }),
  );
  const firstAttemptAt = row?.firstProviderAttemptAt ?? now;
  const windowClosed =
    now.getTime() - firstAttemptAt.getTime() >= PROVIDER_IDEMPOTENCY_WINDOW_MS;
  if (windowClosed || attemptNo >= MAX_ATTEMPTS) {
    // 🔴 ABANDONED either way. An ambiguous attempt that we stop retrying was
    // never confirmed refused, so calling it FAILED would put a claim in the
    // ledger that nothing supports.
    await settle(intentId, "ABANDONED", classification, { ambiguous: true });
    logger.error(
      {
        intentId,
        reason: classification,
        attempts: attemptNo,
        outcome: windowClosed ? "window_closed" : "max_attempts",
      },
      "cancellation email gave up after an ambiguous attempt",
    );
    return "abandoned";
  }
  await release(intentId, classification, new Date(now.getTime() + backoffFor(attemptNo)), {
    ambiguous: true,
  });
  return "retry";
}

/**
 * Terminal. `ambiguous` is left UNTOUCHED unless this settlement followed a
 * real attempt - superseding or suppressing an intent says nothing about what
 * a provider did or did not accept.
 */
async function settle(
  intentId: string,
  status: "FAILED" | "ABANDONED" | "SUPERSEDED" | "SUPPRESSED",
  lastError: string,
  opts: { ambiguous?: boolean } = {},
): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
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

/**
 * Put a row back for a LATER pass, recording only a fixed classification and
 * whether the attempt that just ended left us uncertain.
 *
 * `claimToken` is deliberately NOT cleared: the next claim overwrites it, and
 * that overwrite is what invalidates a stale worker's reservation.
 */
async function release(
  intentId: string,
  lastError: string,
  nextAttemptAt: Date,
  opts: { ambiguous: boolean },
): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: {
        claimedAt: null,
        lastError,
        nextAttemptAt,
        lastAttemptAmbiguous: opts.ambiguous,
      },
    }),
  ).catch(() => {});
}
