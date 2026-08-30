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
 *               message id) and we are past the provider's idempotency window,
 *               so a retry might deliver a SECOND copy. Terminal and visible.
 */
export async function deliverCancellationIntent(params: {
  intentId: string;
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

  // 🔴 COUNT THE ATTEMPT HERE - immediately before a real request, and record
  // when the provider first saw this key. Counting on the worker's claim meant
  // a worker that died five times before dispatching exhausted the budget
  // without Resend ever being contacted.
  const attemptNo = intent.attempts + 1;
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: params.intentId },
      data: {
        attempts: attemptNo,
        firstProviderAttemptAt: intent.firstProviderAttemptAt ?? now,
      },
    }),
  );
  const firstAttemptAt = intent.firstProviderAttemptAt ?? now;

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
      return ambiguous(params.intentId, attemptNo, firstAttemptAt, now, "no_message_id");
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
          nextAttemptAt: null,
          lastError: null,
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
    // Transport died mid-flight - it may or may not have been accepted.
    return ambiguous(params.intentId, attemptNo, firstAttemptAt, now, "transport_error");
  }
}

/** Rejected outright: safe to retry, bounded by MAX_ATTEMPTS. */
async function definitiveFailure(
  intentId: string,
  attemptNo: number,
  classification: string,
  now: Date,
): Promise<IntentOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    await settle(intentId, "FAILED", classification);
    logger.error(
      { intentId, reason: classification, attempts: attemptNo },
      "cancellation email rejected by provider, giving up",
    );
    return "skipped";
  }
  await release(intentId, classification, new Date(now.getTime() + backoffFor(attemptNo)));
  return "retry";
}

/**
 * Might have been delivered. Safe to retry ONLY while the provider still
 * honours the idempotency key - measured from the FIRST attempt, which is when
 * that window actually opened.
 */
async function ambiguous(
  intentId: string,
  attemptNo: number,
  firstAttemptAt: Date,
  now: Date,
  classification: string,
): Promise<IntentOutcome> {
  const windowClosed =
    now.getTime() - firstAttemptAt.getTime() > PROVIDER_IDEMPOTENCY_WINDOW_MS;
  if (windowClosed || attemptNo >= MAX_ATTEMPTS) {
    await settle(intentId, windowClosed ? "ABANDONED" : "FAILED", classification);
    logger.error(
      {
        intentId,
        reason: classification,
        attempts: attemptNo,
        outcome: windowClosed ? "abandoned" : "failed",
      },
      "cancellation email gave up after an ambiguous attempt",
    );
    return windowClosed ? "abandoned" : "skipped";
  }
  await release(intentId, classification, new Date(now.getTime() + backoffFor(attemptNo)));
  return "retry";
}

async function settle(
  intentId: string,
  status: "FAILED" | "ABANDONED" | "SUPERSEDED" | "SUPPRESSED",
  lastError: string,
): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: { status, lastError, claimedAt: null, nextAttemptAt: null },
    }),
  ).catch(() => {});
}

/** Put a row back for a LATER pass, recording only a fixed classification. */
async function release(
  intentId: string,
  lastError: string,
  nextAttemptAt: Date,
): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: { claimedAt: null, lastError, nextAttemptAt },
    }),
  ).catch(() => {});
}
