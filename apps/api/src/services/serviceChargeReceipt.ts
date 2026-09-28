import { runAsOwner } from "@chairback/db";
import { buildServiceChargeReceiptEmail } from "../messaging/templates.js";
import { emailDispatchMode, ResendSendError, sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";
import {
  ambiguous,
  classifyRefusedReservation,
  definitiveFailure,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  reserveAttempt,
  settle,
  type IntentOutcome,
} from "./appointmentCanceledNotify.js";

/**
 * "YOU WILL GET A RECEIPT BY EMAIL EVERY TIME."
 *
 * That sentence is in the v1 service-charge consent customers have already
 * ticked, so every successful saved-card service charge owes one email. It
 * rides the existing durable outbox (EmailIntent + engines/emailOutbox.ts)
 * rather than a direct send, for the same reason the cancellation email does:
 * a direct send lost to a crash or a deploy is lost for good, and nothing
 * would ever notice.
 *
 * EXACTLY ONCE PER ATTEMPT, by two independent walls:
 *  1. the intent's `idempotencyKey` is `service_charge_receipt:<attemptId>` and
 *     UNIQUE, so the response, the webhook and the reconciler - which all
 *     settle the same charge - enqueue ONE intent between them;
 *  2. the same key is Resend's Idempotency-Key, so a retry after an ambiguous
 *     send is collapsed by the provider.
 *
 * Only for method `saved_card`: cash has no card to name, and a Tap to Pay
 * customer was standing at the reader and made no stored-card agreement.
 */

/** The EmailIntent kind. CHECK-pinned in the migration. */
export const SERVICE_CHARGE_RECEIPT_KIND = "service_charge_receipt";

export function serviceChargeReceiptKey(attemptId: string): string {
  return `${SERVICE_CHARGE_RECEIPT_KIND}:${attemptId}`;
}

export function isServiceChargeReceiptKind(kind: string): boolean {
  return kind === SERVICE_CHARGE_RECEIPT_KIND;
}

/**
 * Promise the receipt for one successful saved-card service charge.
 *
 * Safe to call from every settlement path, any number of times: the unique key
 * collapses repeats. Never throws - the charge has happened, and failing to
 * queue its receipt must not turn a paid checkout into an error. A failure here
 * is logged loudly instead, because it is a broken promise to a customer.
 */
export async function enqueueServiceChargeReceipt(params: {
  shopId: string;
  appointmentId: string;
  attemptId: string;
}): Promise<void> {
  try {
    await runAsOwner((tx) =>
      tx.emailIntent.createMany({
        data: [
          {
            kind: SERVICE_CHARGE_RECEIPT_KIND,
            idempotencyKey: serviceChargeReceiptKey(params.attemptId),
            shopId: params.shopId,
            appointmentId: params.appointmentId,
            status: "PENDING",
            nextAttemptAt: new Date(0), // due immediately
          },
        ],
        skipDuplicates: true,
      }),
    );
  } catch (err) {
    logger.error(
      {
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        attemptId: params.attemptId,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "service charge receipt could not be queued",
    );
  }
}

/**
 * Render and send ONE claimed receipt intent. The same state machine as the
 * cancellation email, and the same helpers - see appointmentCanceledNotify.ts
 * for why each step is where it is.
 */
export async function deliverServiceChargeReceiptIntent(params: {
  intentId: string;
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findFirst({
      where: { id: params.intentId, status: "PENDING", claimToken: params.claimToken },
      select: { id: true, shopId: true, appointmentId: true, idempotencyKey: true },
    }),
  );
  if (!intent) return "stale_claim";

  const attemptId = intent.idempotencyKey.slice(`${SERVICE_CHARGE_RECEIPT_KIND}:`.length);
  // Read as the owner: the worker has no shop context, and the intent row -
  // written by our own settlement - is what names the shop.
  const attempt = await runAsOwner((tx) => tx.checkoutAttempt.findFirst({
    where: { id: attemptId, shopId: intent.shopId },
    select: {
      appointmentId: true,
      method: true,
      state: true,
      amountCents: true,
      cardBrand: true,
      cardLast4: true,
      stripePaymentIntentId: true,
      settledAt: true,
    },
  }));
  // Only a charge that actually succeeded has a receipt. Anything else would be
  // telling a customer they paid when they did not.
  if (!attempt || attempt.method !== "saved_card" || attempt.state !== "succeeded") {
    await settle(intent.id, "SUPERSEDED", "not_a_successful_card_charge");
    return "superseded";
  }

  const appt = await runAsOwner((tx) => tx.appointment.findFirst({
    where: { id: attempt.appointmentId, shopId: intent.shopId },
    select: {
      id: true,
      firstName: true,
      email: true,
      startsAt: true,
      manageToken: true,
      client: { select: { email: true, firstName: true } },
      service: { select: { name: true } },
      shop: { select: { name: true, timezone: true } },
    },
  }));
  if (!appt) {
    await settle(intent.id, "SUPERSEDED", "appointment_gone");
    return "superseded";
  }

  // Before anything that could dispatch: an ambiguous earlier attempt past the
  // provider's idempotency window may already have been delivered, and a new
  // request now would be a second copy.
  const expired = await runAsOwner((tx) =>
    tx.emailIntent.updateMany({
      where: {
        id: intent.id,
        status: "PENDING",
        claimToken: params.claimToken,
        lastAttemptAmbiguous: true,
        firstProviderAttemptAt: { lte: new Date(now.getTime() - PROVIDER_IDEMPOTENCY_WINDOW_MS) },
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
  if (expired.count > 0) return "abandoned";

  const to = appt.email ?? appt.client?.email ?? null;
  if (!to) {
    // Nobody to write to. Visible in the ledger rather than silently dropped.
    await settle(intent.id, "FAILED", "no_address");
    return "skipped";
  }
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(intent.id, "SUPPRESSED", mode);
    return "suppressed";
  }

  const email = buildServiceChargeReceiptEmail({
    firstName: appt.firstName ?? appt.client?.firstName ?? null,
    shopName: appt.shop.name,
    serviceName: appt.service?.name ?? "appointment",
    startsAt: appt.startsAt,
    timezone: appt.shop.timezone,
    cents: attempt.amountCents,
    brand: attempt.cardBrand,
    last4: attempt.cardLast4,
    chargedAt: attempt.settledAt ?? now,
    // The tail of the Stripe id: enough for the shop to find it in Stripe,
    // not the whole identifier in someone's inbox.
    reference: receiptReference(attempt.stripePaymentIntentId, attemptId),
    manageToken: appt.manageToken,
  });

  const attemptNo = await reserveAttempt(intent.id, params.claimToken, now);
  if (attemptNo === null) return classifyRefusedReservation(params, now);

  // ---- THE BOUNDARY: everything above is durable.
  try {
    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: appt.shop.name,
      stream: "transactional",
      idempotencyKey: intent.idempotencyKey,
      meta: { shopId: intent.shopId, appointmentId: appt.id, kind: "service_charge_receipt" },
    });
    if (result.status !== "sent" || !result.id || result.id === "unknown") {
      return ambiguous(intent.id, attemptNo, now, "no_message_id");
    }
    await runAsOwner(async (tx) => {
      await tx.emailIntent.update({
        where: { id: intent.id },
        data: {
          status: "SENT",
          sentAt: now,
          messageId: result.id,
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
          lastError: null,
          lastAttemptAmbiguous: false,
        },
      });
      await tx.emailDelivery.upsert({
        where: { messageId: result.id },
        create: {
          messageId: result.id,
          kind: "service_charge_receipt",
          shopId: intent.shopId,
          appointmentId: appt.id,
          status: "sent",
        },
        update: {
          kind: "service_charge_receipt",
          shopId: intent.shopId,
          appointmentId: appt.id,
          awaitingDispatchMeta: false,
        },
      });
    });
    return "sent";
  } catch (err) {
    if (err instanceof ResendSendError) {
      return definitiveFailure(intent.id, attemptNo, err.classification, now);
    }
    return ambiguous(intent.id, attemptNo, now, "transport_error");
  }
}

/** The last eight characters of the Stripe id, upper-cased - never the full id. */
function receiptReference(paymentIntentId: string | null, attemptId: string): string {
  const source = paymentIntentId && !paymentIntentId.startsWith("pending:") ? paymentIntentId : attemptId;
  return source.slice(-8).toUpperCase();
}
