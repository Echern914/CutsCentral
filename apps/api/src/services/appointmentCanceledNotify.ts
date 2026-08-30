import { Prisma, runAsOwner } from "@chairback/db";
import { buildAppointmentCanceledEmail } from "../messaging/templates.js";
import { ResendSendError, sendEmail } from "../messaging/email.js";
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
  canceledAt: Date,
): string {
  return `cancel:${appointmentId}:${canceledAt.getTime()}`;
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
  params: { shopId: string; appointmentId: string; canceledAt: Date },
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

  const idempotencyKey = cancellationIdempotencyKey(appt.id, params.canceledAt);
  // Two concurrent cancels race this insert; the unique index picks the
  // winner and the loser is a silent no-op.
  await tx.emailIntent.createMany({
    data: [
      {
        kind: "appointment_canceled",
        idempotencyKey,
        shopId: params.shopId,
        appointmentId: appt.id,
        status: "PENDING",
      },
    ],
    skipDuplicates: true,
  });
  return idempotencyKey;
}

export type IntentOutcome =
  | "sent"
  | "skipped"
  | "retry"
  | "abandoned"
  | "not_found";

/**
 * Render and send ONE pending intent. Called only by the outbox worker, which
 * has already claimed the row.
 *
 * `cancellationEmailSentAt` is stamped only AFTER the provider accepts - it is
 * a record of what happened, never a promise about what is about to.
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
  // Restored to BOOKED (or turned into a NO_SHOW) between enqueue and send:
  // the message would now be a lie, so retire the intent rather than send it.
  if (!appt || !NOTIFIABLE.has(appt.status)) {
    await settle(params.intentId, "FAILED", "superseded");
    return "skipped";
  }

  const to = appt.email ?? appt.client?.email ?? null;
  if (!to) {
    await settle(params.intentId, "FAILED", "no_address");
    return "skipped";
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

  try {
    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: appt.shop.name,
      stream: "transactional",
      // The PROVIDER-side exactly-once guard. Resend collapses repeat
      // attempts carrying the same key, so retrying an ambiguous send cannot
      // deliver twice.
      idempotencyKey: intent.idempotencyKey,
      meta: {
        shopId: intent.shopId,
        appointmentId: appt.id,
        kind: "cancellation",
      },
    });

    if (result.status === "skipped") {
      // Email is not configured at all. Leave it PENDING so it goes out if
      // and when it is - nothing has been lost.
      await release(params.intentId);
      return "retry";
    }

    await runAsOwner(async (tx) => {
      await tx.emailIntent.update({
        where: { id: params.intentId },
        data: {
          status: "SENT",
          sentAt: now,
          messageId: result.id,
          claimedAt: null,
          lastError: null,
        },
      });
      // 🔴 Only NOW. The stamp records provider acceptance, nothing sooner.
      await tx.appointment.updateMany({
        where: { id: appt.id, shopId: intent.shopId },
        data: { cancellationEmailSentAt: now },
      });
    });
    return "sent";
  } catch (err) {
    const classification =
      err instanceof ResendSendError ? err.classification : "provider_error";
    return finishFailure(params.intentId, intent.attempts, classification, now);
  }
}

/**
 * Resend deduplicates by Idempotency-Key for 24 hours. Inside that window a
 * retry is safe: a first attempt that may have landed will be collapsed.
 * OUTSIDE it, the key means nothing and a retry is a coin flip that can
 * deliver a second copy - so the intent is ABANDONED instead, terminal and
 * visible, rather than retried forever or silently dropped.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

async function finishFailure(
  intentId: string,
  attempts: number,
  classification: string,
  now: Date,
): Promise<IntentOutcome> {
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findUnique({
      where: { id: intentId },
      select: { createdAt: true },
    }),
  );
  const agedOut =
    !!intent &&
    now.getTime() - intent.createdAt.getTime() > PROVIDER_IDEMPOTENCY_WINDOW_MS;

  if (agedOut || attempts + 1 >= MAX_ATTEMPTS) {
    await settle(intentId, agedOut ? "ABANDONED" : "FAILED", classification);
    logger.error(
      { intentId, reason: classification, outcome: agedOut ? "abandoned" : "failed" },
      "cancellation email intent gave up",
    );
    return agedOut ? "abandoned" : "skipped";
  }
  await release(intentId, classification);
  return "retry";
}

async function settle(
  intentId: string,
  status: "FAILED" | "ABANDONED",
  lastError: string,
): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: { status, lastError, claimedAt: null },
    }),
  ).catch(() => {});
}

/** Put a row back for another pass, recording only a fixed classification. */
async function release(intentId: string, lastError?: string): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: { claimedAt: null, ...(lastError ? { lastError } : {}) },
    }),
  ).catch(() => {});
}
