import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";
import { errorClassification, stripeErrorFacts } from "./stripeErrors.js";

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

/** The only currency ChairBack charges in. Anything else is refused at the boundary. */
export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["usd"]);
/** $100,000 in cents - far past any real ticket; an overflow / fat-finger ceiling. */
export const MAX_CHARGE_CENTS = 10_000_000;

/**
 * A Payment row that exists BEFORE Stripe has been asked for anything carries
 * this prefix + its own id where the PaymentIntent id will go. That row is the
 * reservation: the durable proof an attempt was made, written ahead of the
 * network call so a crash or a lost reply leaves a trace the reconciler can
 * act on. Every charge path here follows the same order - row, then Stripe,
 * then the row again - and re-issues the SAME request under the SAME
 * idempotency key on a retry, so Stripe collapses it to the one intent.
 */
export const PENDING_INTENT_PREFIX = "pending:";
export function pendingIntentId(paymentId: string): string {
  return `${PENDING_INTENT_PREFIX}${paymentId}`;
}
export function isPendingIntentId(id: string): boolean {
  return id.startsWith(PENDING_INTENT_PREFIX);
}

/**
 * Integer cents inside (0, MAX] in a supported currency - or the reason it is
 * not. Every amount that reaches Stripe from this module passes through here;
 * a float, a negative, a zero, a nonsense currency or an overflow is refused
 * before a row exists, never "rounded into shape".
 */
export function validateCharge(amountCents: number, currency: string): string | null {
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents)) return "amount_not_integer";
  if (amountCents <= 0) return "amount_not_positive";
  if (amountCents > MAX_CHARGE_CENTS) return "amount_too_large";
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase())) {
    return "unsupported_currency";
  }
  return null;
}

/**
 * What a DEPOSIT-mode booking charges NOW, in cents.
 *
 * Two rules, both there to stop a deposit becoming a surprise:
 *  - CAP AT THE PRICE. A shop-wide $20 deposit must not overcharge a $15
 *    line-up. Capped, the customer pays $15 now and owes nothing at the chair,
 *    which is honest; charging $20 for a $15 service is not.
 *  - NO CHARGE WITHOUT BOTH NUMBERS. An unpriced service, or a shop that
 *    switched to deposit mode without setting an amount, charges NOTHING and
 *    falls back to paying in person. Guessing a deposit is worse than not
 *    taking one.
 */
export function depositChargeCents(
  depositCents: number | null | undefined,
  fullCents: number | null,
): number | null {
  if (fullCents === null || fullCents <= 0) return null;
  if (depositCents === null || depositCents === undefined || depositCents <= 0) return null;
  return Math.min(depositCents, fullCents);
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
 * AFTER the appointment is durably committed. Returns null (logged, never
 * throws) on any Stripe error so a booking is never lost to a payment hiccup —
 * the customer just falls back to pay-in-person for that visit.
 *
 * 🔴 ROW FIRST, STRIPE SECOND. The Payment row is written with a
 * `pending:` intent id BEFORE the network call. That order is what makes the
 * three bad endings recoverable instead of silent:
 *   - crash after the row, before the request: the row says "pending", the
 *     reconciler finds nothing at Stripe and marks it failed; no money moved.
 *   - timeout after Stripe accepted: the row says "pending", a retry re-issues
 *     the identical request under the identical key and Stripe hands back the
 *     intent it already made; the reconciler can also find it by metadata.
 *   - a second request for the same appointment (double-submit, two tabs):
 *     the unique appointmentId makes the second caller REUSE the first row -
 *     and therefore the first key - so two callers cannot mint two intents.
 * The amounts on the retry come from the ROW, not the caller, so the request
 * under a reused key can never differ from the first one.
 */
export async function createAheadPaymentIntent(
  input: CreateIntentInput,
): Promise<{ clientSecret: string; paymentId: string } | null> {
  const currency = (input.currency ?? "usd").toLowerCase();
  const invalid = validateCharge(input.amountCents, currency);
  if (invalid) {
    logger.error(
      { appointmentId: input.appointmentId, reason: invalid },
      "createAheadPaymentIntent refused: invalid amount or currency",
    );
    return null;
  }
  const feeAmount = Math.floor((input.amountCents * input.platformFeeBps) / 10000);
  try {
    // One Payment row per appointment (unique). A prior attempt that got as far
    // as a real intent is simply handed back; one that never got an answer is
    // the retry case below.
    const existing = await prisma.payment.findUnique({
      where: { appointmentId: input.appointmentId },
      select: {
        id: true,
        stripePaymentIntentId: true,
        status: true,
        mode: true,
        amount: true,
        currency: true,
        applicationFeeAmount: true,
        stripeConnectAccountId: true,
      },
    });
    if (existing && !isPendingIntentId(existing.stripePaymentIntentId)) {
      const pi = await stripeClient().paymentIntents.retrieve(existing.stripePaymentIntentId);
      return pi.client_secret
        ? { clientSecret: pi.client_secret, paymentId: existing.id }
        : null;
    }
    if (existing && existing.mode !== "ahead") {
      // A card-on-file fee is mid-flight for this appointment. Not ours to
      // touch, and certainly not ours to replace with a second charge.
      logger.warn(
        { appointmentId: input.appointmentId, mode: existing.mode },
        "createAheadPaymentIntent refused: another payment is pending for this appointment",
      );
      return null;
    }

    // THE RESERVATION. Pre-mint the row id so the intent's metadata can point
    // back at it, and write the row before Stripe hears about any of this.
    const paymentId = existing?.id ?? cryptoRandomId();
    if (!existing) {
      await prisma.payment.create({
        data: {
          id: paymentId,
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          stripePaymentIntentId: pendingIntentId(paymentId),
          stripeConnectAccountId: input.connectAccountId,
          mode: "ahead",
          amount: input.amountCents,
          currency,
          applicationFeeAmount: feeAmount,
          status: "requires_payment_method",
        },
      });
    }
    // On a retry the request is rebuilt from the row, never from the caller.
    const amount = existing?.amount ?? input.amountCents;
    const fee = existing?.applicationFeeAmount ?? feeAmount;
    const destination = existing?.stripeConnectAccountId ?? input.connectAccountId;
    const cur = existing?.currency ?? currency;

    try {
      const intent = await stripeClient().paymentIntents.create(
        {
          amount,
          currency: cur,
          // Destination charge: settles to the barber; platform is MoR-adjacent only.
          on_behalf_of: destination,
          transfer_data: { destination },
          ...(fee > 0 ? { application_fee_amount: fee } : {}),
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
      // Only the row that still says "pending" is adopted - a webhook or the
      // reconciler may have got there first, and their answer stands.
      await prisma.payment.updateMany({
        where: { id: paymentId, stripePaymentIntentId: pendingIntentId(paymentId) },
        data: { stripePaymentIntentId: intent.id, status: intent.status, ambiguousAt: null },
      });
      return intent.client_secret
        ? { clientSecret: intent.client_secret, paymentId }
        : null;
    } catch (err) {
      const facts = stripeErrorFacts(err);
      if (!facts.definitive) {
        // The request may have been accepted. Mark it, do not guess, and let
        // the reconciler read Stripe. The row keeps its pending id, so the
        // next attempt for this appointment reuses the same key.
        await prisma.payment.updateMany({
          where: { id: paymentId },
          data: { ambiguousAt: new Date() },
        });
      }
      logger.error(
        { appointmentId: input.appointmentId, paymentId, ...facts },
        facts.definitive
          ? "createAheadPaymentIntent refused by Stripe"
          : "createAheadPaymentIntent outcome unknown - the reconciler owns it",
      );
      return null;
    }
  } catch (err) {
    logger.error(
      { appointmentId: input.appointmentId, errName: errorClassification(err) },
      "createAheadPaymentIntent failed",
    );
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
          { paymentId: payment.id, ...stripeErrorFacts(err) },
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
    // Compare-and-set on the figure this refund was computed from. Two
    // concurrent partial refunds both read the same refundedAmount and both
    // build the same idempotency key, so Stripe hands them the SAME refund;
    // only the first local write may land, and the loser's stale total must
    // not overwrite it. charge.refunded (monotonic) converges the rest.
    const { count } = await prisma.payment.updateMany({
      where: { id: payment.id, refundedAmount: payment.refundedAmount },
      data: {
        refundedAmount: newRefunded,
        status: newRefunded >= collected ? "refunded" : "partially_refunded",
        ambiguousAt: null,
      },
    });
    if (count === 0) {
      logger.info(
        { paymentId: payment.id },
        "refund recorded at Stripe; local total already moved by a concurrent writer or the webhook",
      );
    }
    return refund.amount ?? refundable;
  } catch (err) {
    const facts = stripeErrorFacts(err);
    if (!facts.definitive) {
      // The refund may exist at Stripe. Mark, never guess: a retry reuses
      // the same key (refundedAmount unchanged), so Stripe returns the one
      // refund rather than making another; charge.refunded also lands it.
      await prisma.payment
        .updateMany({ where: { id: params.paymentId }, data: { ambiguousAt: new Date() } })
        .catch(() => {});
    }
    logger.error(
      { paymentId: params.paymentId, ...facts },
      facts.definitive
        ? "refundForCancellation refused by Stripe"
        : "refundForCancellation outcome unknown - the reconciler owns it",
    );
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
      await applyIntentSnapshot(pi, event.id);
      if (pi.status === "succeeded") await promoteHoldForPaidIntent(pi);
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
    case "setup_intent.succeeded": {
      // Card on file: the customer's card is attached; promote the hold. Same
      // idempotency posture as the intents above (the row's status is the CAS).
      // Dynamic import: cardOnFile.ts imports this module's neighbours.
      const si = event.data.object as Stripe.SetupIntent;
      const { markCardSaved } = await import("./cardOnFile.js");
      await markCardSaved(si, { eventId: event.id });
      return true;
    }
    default:
      return false; // not a payment event (account.updated handled in connect.ts)
  }
}

/**
 * Fold what Stripe says about an intent into its Payment row. Shared by the
 * webhook (marker = the event id) and the reconciler (marker = intent id +
 * status, so the same answer read twice is applied once).
 *
 * Stripe redelivers webhooks for ~3 days and out of order. A stale
 * processing/canceled/failed snapshot arriving AFTER succeeded must NOT flip
 * the row off "succeeded" - that would silently block its refund
 * (refundForCancellation gates on succeeded). So only a succeeded snapshot may
 * write a terminal/collected row; the others no-op against one.
 *
 * A row still carrying its `pending:` reservation id adopts the real intent
 * id here - this is how a reply that never arrived is recovered from the
 * webhook, or by the reconciler's search.
 */
export async function applyIntentSnapshot(
  pi: Pick<Stripe.PaymentIntent, "id" | "status" | "amount_received" | "latest_charge" | "metadata">,
  markerId: string,
  opts: { reconciled?: boolean } = {},
): Promise<void> {
  const chargeId =
    typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
  const noDowngrade = pi.status !== "succeeded";
  await reconcile(
    markerId,
    { paymentId: pi.metadata?.paymentId, piId: pi.id },
    {
      stripePaymentIntentId: pi.id,
      status: pi.status,
      ...(chargeId ? { stripeChargeId: chargeId } : {}),
      ...(pi.status === "succeeded" ? { capturedAmount: pi.amount_received } : {}),
      ...(opts.reconciled ? { ambiguousAt: null, reconciledAt: new Date() } : {}),
    },
    noDowngrade ? ["succeeded", "refunded", "partially_refunded"] : undefined,
  );
}

/**
 * The money landed: turn the payment hold into a real booking.
 *
 * This is the moment a deposit/pay-ahead booking becomes real. Until it runs,
 * the appointment is a PENDING hold that expires on its own, so a customer who
 * abandons the payment screen releases the chair instead of keeping it.
 *
 * Deliberately only on `succeeded`. `payment_intent.payment_failed` is NOT a
 * signal to release the hold: a declined card leaves the intent reusable and
 * the customer is very often typing in a second one. Letting the window lapse
 * is the only honest way to tell "gave up" from "trying again".
 *
 * If we cannot honor the slot after taking the money, refund it in full -
 * never leave a customer charged for an appointment that does not exist.
 *
 * Dynamically imported to keep the dependency one-directional: the hold
 * service imports this module for refunds, so a static import here would be a
 * cycle. Same pattern services/referral.ts uses to reach the Stripe client.
 */
async function promoteHoldForPaidIntent(pi: Stripe.PaymentIntent): Promise<void> {
  const appointmentId = pi.metadata?.appointmentId;
  const shopId = pi.metadata?.shopId;
  if (!appointmentId || !shopId) return; // not a booking payment (terminal, etc.)
  try {
    const { promotePaidHold, refundUnhonoredHold } = await import(
      "../services/appointmentPaymentHold.js"
    );
    const outcome = await promotePaidHold({ appointmentId });
    if (outcome === "lapsed" || outcome === "slot_taken") {
      await refundUnhonoredHold({ appointmentId, shopId });
    }
  } catch (err) {
    // Never throw into the webhook: Stripe would retry the whole event and
    // re-run the reconcile above. The row is already correct; the appointment
    // is recoverable by hand and loud in the log.
    logger.error({ appointmentId, errName: errorClassification(err) }, "promoting a paid hold failed");
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
