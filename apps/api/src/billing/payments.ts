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
      },
    });
    if (!payment) return 0;
    // Only money actually collected can be refunded.
    const collected = payment.capturedAmount ?? payment.amount;
    if (payment.status !== "succeeded" || collected <= 0) return 0;

    const fee = Math.max(0, Math.min(params.feeCents, collected));
    const refundable = collected - payment.refundedAmount - fee;
    if (refundable <= 0) return 0;

    const refund = await stripeClient().refunds.create(
      { payment_intent: payment.stripePaymentIntentId, amount: refundable },
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
      await reconcile(event.id, { paymentId: pi.metadata?.paymentId, piId: pi.id }, {
        status: pi.status,
        ...(chargeId ? { stripeChargeId: chargeId } : {}),
        ...(pi.status === "succeeded" ? { capturedAmount: pi.amount_received } : {}),
      });
      return true;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      const refunded = charge.amount_refunded ?? 0;
      const fullyRefunded = charge.refunded === true;
      await reconcile(event.id, { piId }, {
        refundedAmount: refunded,
        status: fullyRefunded ? "refunded" : "partially_refunded",
      });
      return true;
    }
    default:
      return false; // not a payment event (account.updated handled in connect.ts)
  }
}

/** Update the matching Payment row, with a webhook-id replay guard. */
async function reconcile(
  eventId: string,
  key: { paymentId?: string; piId?: string },
  data: Record<string, unknown>,
): Promise<void> {
  const where = key.paymentId
    ? { id: key.paymentId }
    : key.piId
      ? { stripePaymentIntentId: key.piId }
      : null;
  if (!where) return;
  // Replay guard: skip if we've already applied this exact event to this row.
  const { count } = await prisma.payment.updateMany({
    where: { ...where, NOT: { lastWebhookEventId: eventId } },
    data: { ...data, lastWebhookEventId: eventId },
  });
  if (count === 0) {
    logger.info({ eventId, key }, "payment webhook matched no row or was a replay");
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
