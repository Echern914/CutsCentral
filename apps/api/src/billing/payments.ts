import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";

/**
 * Customer PaymentIntents for native bookings, via the shop's connected account.
 *
 * Money model (locked): DESTINATION charge created on the PLATFORM account with
 * `transfer_data.destination = acct_…` + `on_behalf_of = acct_…`, so the BARBER
 * is merchant of record / settlement entity (owns disputes + 1099-K) while we
 * keep one control plane (one secret key, one webhook, platform-side
 * refunds/captures). `application_fee_amount` is threaded but 0 for v1.
 *
 * Phase 2 = AHEAD only (capture at booking). HOLD (manual capture) is Phase 3.
 * Every Stripe call here runs AFTER the booking tx has committed (never hold a
 * Postgres tx across a network call), and the Payment row is the durable record
 * the webhook reconciles against.
 */

/** Cents from a Decimal-ish price; null when there's no usable amount. */
export function toCents(price: number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  const cents = Math.round(Number(price) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

interface CreateIntentInput {
  shopId: string;
  appointmentId: string;
  connectAccountId: string;
  amountCents: number;
  platformFeeBps: number;
  currency?: string;
  /** A short label the customer sees on the Stripe sheet / statement. */
  description?: string;
}

/**
 * Create a Payment row + an AHEAD PaymentIntent (automatic capture, card +
 * Apple Pay + Link). Returns the client secret for the Payment Element. Called
 * AFTER the appointment is durably committed. Idempotent per appointment via the
 * unique Payment.appointmentId + a per-attempt idempotency key. Returns null
 * (logged, never throws) on any Stripe error so a booking is never lost to a
 * payment hiccup — the customer just falls back to pay-in-person for that visit.
 */
export async function createAheadPaymentIntent(
  input: CreateIntentInput,
): Promise<{ clientSecret: string; paymentId: string } | null> {
  const currency = input.currency ?? "usd";
  const feeAmount = Math.floor((input.amountCents * input.platformFeeBps) / 10000);
  try {
    // One Payment row per appointment (unique). If a prior attempt already made
    // one (retry/double-submit), reuse its PI rather than creating a second.
    const existing = await prisma.payment.findUnique({
      where: { appointmentId: input.appointmentId },
      select: { id: true, stripePaymentIntentId: true, status: true },
    });
    if (existing) {
      const pi = await stripeClient().paymentIntents.retrieve(existing.stripePaymentIntentId);
      return pi.client_secret
        ? { clientSecret: pi.client_secret, paymentId: existing.id }
        : null;
    }

    // Pre-create the row id so the PI metadata can point back at it before the
    // PI exists (the webhook keys on metadata.paymentId / appointmentId).
    const paymentId = cryptoRandomId();
    const intent = await stripeClient().paymentIntents.create(
      {
        amount: input.amountCents,
        currency,
        // Destination charge: settles to the barber; platform is MoR-adjacent only.
        on_behalf_of: input.connectAccountId,
        transfer_data: { destination: input.connectAccountId },
        ...(feeAmount > 0 ? { application_fee_amount: feeAmount } : {}),
        capture_method: "automatic",
        automatic_payment_methods: { enabled: true }, // card + Apple Pay + Link
        description: input.description,
        metadata: {
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          paymentId,
        },
      },
      { idempotencyKey: `pi-create:${paymentId}` },
    );

    await prisma.payment.create({
      data: {
        id: paymentId,
        shopId: input.shopId,
        appointmentId: input.appointmentId,
        stripePaymentIntentId: intent.id,
        stripeConnectAccountId: input.connectAccountId,
        mode: "ahead",
        amount: input.amountCents,
        currency,
        applicationFeeAmount: feeAmount,
        status: intent.status,
      },
    });

    return intent.client_secret
      ? { clientSecret: intent.client_secret, paymentId }
      : null;
  } catch (err) {
    logger.error({ err, appointmentId: input.appointmentId }, "createAheadPaymentIntent failed");
    return null;
  }
}

/**
 * Refund a (succeeded) payment, fully or partially, honoring the shop's
 * cancellation policy. Returns the refunded cents (0 if nothing to refund).
 * Never throws into the cancel flow. Idempotent-ish: re-refunding an
 * already-fully-refunded payment is a no-op.
 */
export async function refundForCancellation(params: {
  paymentId: string;
  /** cents to KEEP as a cancellation fee (0 = full refund). */
  feeCents: number;
}): Promise<number> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: params.paymentId },
      select: {
        id: true,
        stripePaymentIntentId: true,
        amount: true,
        refundedAmount: true,
        status: true,
        capturedAmount: true,
        applicationFeeAmount: true,
      },
    });
    if (!payment) return 0;

    // The payment may still be IN FLIGHT when the customer cancels (they paid
    // then immediately canceled before payment_intent.succeeded arrived). A
    // refund can't apply to a not-yet-collected charge, so instead CANCEL the
    // PaymentIntent - which voids an authorization or aborts a processing charge
    // so the customer is never left charged-without-refund. Terminal states
    // (canceled/refunded/failed) are no-ops.
    const inFlight = new Set([
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
      "processing",
      "requires_capture",
    ]);
    if (inFlight.has(payment.status)) {
      try {
        await stripeClient().paymentIntents.cancel(payment.stripePaymentIntentId);
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "canceled" },
        });
      } catch (err) {
        // If it succeeded in the gap between our read and the cancel, Stripe
        // refuses the cancel; the charge.succeeded webhook will mark it succeeded
        // and a later manual refund can recover it. Log, don't throw.
        logger.warn(
          { err, paymentId: payment.id },
          "in-flight PI cancel failed (likely already captured); needs manual review",
        );
      }
      return 0;
    }

    // A refund is valid against money actually collected. succeeded =
    // ahead-mode auto-capture; partially_refunded = a prior partial refund.
    const refundableStatuses = new Set(["succeeded", "partially_refunded"]);
    const collected = payment.capturedAmount ?? payment.amount;
    if (!refundableStatuses.has(payment.status) || collected <= 0) return 0;

    const fee = Math.max(0, Math.min(params.feeCents, collected));
    const refundable = collected - payment.refundedAmount - fee;
    if (refundable <= 0) return 0;

    const refund = await stripeClient().refunds.create(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount: refundable,
        // CRITICAL for destination charges: the charge lives on the PLATFORM
        // balance but the funds were transferred to the barber. reverse_transfer
        // claws the refund back out of the BARBER's connected balance, so the
        // platform never eats the refund. Without it, every refund is a straight
        // platform loss while the barber keeps the original payment.
        reverse_transfer: true,
        // When a platform fee was taken, refund our proportional cut too, so we
        // don't keep a fee on a (partly) refunded charge. No-op when fee is 0.
        ...(payment.applicationFeeAmount > 0 ? { refund_application_fee: true } : {}),
      },
      { idempotencyKey: `refund:${payment.id}:${payment.refundedAmount}` },
    );
    const newRefunded = payment.refundedAmount + (refund.amount ?? refundable);
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedAmount: newRefunded,
        status: newRefunded >= collected ? "refunded" : "partially_refunded",
      },
    });
    return refund.amount ?? refundable;
  } catch (err) {
    logger.error({ err, paymentId: params.paymentId }, "refundForCancellation failed");
    return 0;
  }
}

/**
 * Reconcile a Connect payment/charge webhook event into the Payment row. Keyed
 * by metadata.paymentId (set at create) with a PI-id fallback. Dedups via
 * lastWebhookEventId. Tolerant of unknown payments. Never throws.
 */
export async function applyPaymentEvent(event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
    case "payment_intent.processing": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const chargeId =
        typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
      // Stripe redelivers webhooks for ~3 days and out of order. A stale
      // processing/canceled/failed event arriving AFTER succeeded must NOT flip
      // the row off "succeeded" - that would silently block its refund
      // (refundForCancellation gates on succeeded). So only the succeeded event
      // may write a terminal/collected row; the others no-op against one.
      const noDowngrade = pi.status !== "succeeded";
      await reconcile(
        event.id,
        { paymentId: pi.metadata?.paymentId, piId: pi.id },
        {
          status: pi.status,
          ...(chargeId ? { stripeChargeId: chargeId } : {}),
          ...(pi.status === "succeeded" ? { capturedAmount: pi.amount_received } : {}),
        },
        noDowngrade ? ["succeeded", "refunded", "partially_refunded"] : undefined,
      );
      return true;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      // amount_refunded is the CUMULATIVE refund total on the charge, so the
      // write is absolute (not additive). Stripe redelivers + reorders events for
      // ~3 days, so an OLDER charge.refunded (lower cumulative total) can arrive
      // AFTER a newer one. Without a guard, the older event would overwrite a
      // higher refundedAmount with a lower one - moving it BACKWARD - which then
      // inflates refundForCancellation's `refundable = collected - refundedAmount
      // - fee` and risks an over-refund, and can flip status refunded ->
      // partially_refunded. So only apply when this total is >= what's stored
      // (monotonic). Mirrors the noDowngrade guard the payment_intent.* events
      // already use for the same out-of-order reason.
      const refunded = charge.amount_refunded ?? 0;
      const fullyRefunded = charge.refunded === true;
      await reconcile(
        event.id,
        { piId },
        {
          refundedAmount: refunded,
          status: fullyRefunded ? "refunded" : "partially_refunded",
        },
        undefined,
        { refundedAmount: { lte: refunded } },
      );
      return true;
    }
    default:
      return false; // not a payment event (account.updated handled in connect.ts)
  }
}

/**
 * Update the matching Payment row, with a webhook-id replay guard. When
 * `noDowngradeFrom` is given, the update is additionally refused if the row is
 * already in one of those statuses - so a stale/out-of-order non-succeeded event
 * cannot downgrade an already-collected/refunded payment. `extraWhere` adds an
 * arbitrary extra predicate the row must satisfy for the write to apply (used by
 * charge.refunded to enforce monotonic refundedAmount against reordered events);
 * if it doesn't match, the update is a safe no-op (logged, like a replay).
 */
async function reconcile(
  eventId: string,
  key: { paymentId?: string; piId?: string },
  data: Record<string, unknown>,
  noDowngradeFrom?: string[],
  extraWhere?: Record<string, unknown>,
): Promise<void> {
  const where = key.paymentId
    ? { id: key.paymentId }
    : key.piId
      ? { stripePaymentIntentId: key.piId }
      : null;
  if (!where) return;
  // Replay guard: skip ONLY if we've already applied this exact event to this
  // row. Downgrade guard: skip if the row is already terminal/collected.
  //
  // NULL TRAP (this caused a prod outage): for a NULLABLE column, BOTH
  // `NOT: { lastWebhookEventId: id }` AND `lastWebhookEventId: { not: id }`
  // compile to SQL that is NULL — not TRUE — for a row whose value IS NULL, so a
  // brand-new payment (lastWebhookEventId NULL = never reconciled) matched 0
  // rows and the charge silently never reconciled (status stuck at
  // requires_payment_method while the card SUCCEEDED on Stripe). The replay
  // guard must EXPLICITLY treat NULL as "not yet seen → allow": match rows where
  // the id is NULL OR differs from this event.
  const { count } = await prisma.payment.updateMany({
    where: {
      ...where,
      OR: [
        { lastWebhookEventId: null },
        { lastWebhookEventId: { not: eventId } },
      ],
      ...(noDowngradeFrom && noDowngradeFrom.length > 0
        ? { status: { notIn: noDowngradeFrom } }
        : {}),
      ...(extraWhere ?? {}),
    },
    data: { ...data, lastWebhookEventId: eventId },
  });
  if (count === 0) {
    logger.info(
      { eventId, key },
      "payment webhook matched no row, was a replay, or was a refused downgrade",
    );
  }
}

/** cuid-ish id without pulling a dep; matches the Payment.id shape closely enough. */
function cryptoRandomId(): string {
  // Prisma's @default(cuid()) only applies when id is omitted; here we set it
  // explicitly so the PI metadata can reference it pre-insert. Use a prefixed
  // random hex (collision-safe for this volume) rather than reimplement cuid.
  return "pay_" + randomHex(24);
}
function randomHex(n: number): string {
  // Node crypto via dynamic import-free require-equivalent: use globalThis.crypto.
  const bytes = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
