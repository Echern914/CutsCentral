import type Stripe from "stripe";
import { prisma, runWithShop } from "@chairback/db";
import type { CardOnFileChargeReason } from "@chairback/config";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";
import { errorClassification, stripeErrorFacts } from "./stripeErrors.js";

/**
 * Card on file: keep the customer's card at booking WITHOUT charging it.
 *
 * WHY THIS IS NOT A PaymentIntent WITH `capture_method: manual`. A manual
 * capture authorises an amount and expires in ~7 days; a card on file has no
 * amount and must outlive a booking made three weeks out. Stripe's object for
 * "save this card for later" is the SetupIntent, and a later fee is a fresh
 * off-session PaymentIntent against the saved payment method (PR 2).
 *
 * TOPOLOGY. Destination charges live on the PLATFORM account
 * (billing/payments.ts), so the Customer and the SetupIntent are created on
 * the platform too, with `on_behalf_of` naming the barber's connected account.
 * One Customer PER BOOKING, never shared: a card saved for shop A must be
 * structurally impossible to charge for shop B, and the simplest structure is
 * that it is attached to a Customer that belongs to exactly one appointment.
 *
 * The booking is a PENDING hold (holdReason "payment", the same machinery the
 * deposit flow uses) until the SetupIntent succeeds. Two paths promote it:
 * the webhook (`setup_intent.succeeded`), and a server-side RETRIEVE the
 * browser asks for right after `confirmSetup` - so the customer's confirmation
 * never depends on a webhook subscription being configured.
 *
 * Never throws out of the create path: a Stripe hiccup must never cost a
 * customer their appointment. Returns null and the caller promotes the hold as
 * a pay-in-person booking, exactly as the deposit flow does.
 */

export interface CreateCardOnFileInput {
  shopId: string;
  appointmentId: string;
  connectAccountId: string;
  customer: { name: string; email: string | null; phone: string | null };
  description: string;
}

export async function createCardOnFileSetupIntent(
  input: CreateCardOnFileInput,
): Promise<{ clientSecret: string; cardOnFileId: string } | null> {
  try {
    // A retry / double-submit reuses the row and its intent rather than minting
    // a second Customer.
    const existing = await runWithShop(input.shopId, (tx) =>
      tx.cardOnFile.findUnique({
        where: { appointmentId: input.appointmentId },
        select: { id: true, stripeSetupIntentId: true },
      }),
    );
    if (existing) {
      const si = await stripeClient().setupIntents.retrieve(existing.stripeSetupIntentId);
      return si.client_secret ? { clientSecret: si.client_secret, cardOnFileId: existing.id } : null;
    }

    const cardOnFileId = cryptoRandomId();
    const customer = await stripeClient().customers.create(
      {
        name: input.customer.name,
        ...(input.customer.email ? { email: input.customer.email } : {}),
        ...(input.customer.phone ? { phone: input.customer.phone } : {}),
        metadata: { shopId: input.shopId, appointmentId: input.appointmentId, cardOnFileId },
      },
      { idempotencyKey: `cof-customer:${cardOnFileId}` },
    );
    const intent = await stripeClient().setupIntents.create(
      {
        customer: customer.id,
        usage: "off_session",
        on_behalf_of: input.connectAccountId,
        // 🔴 WAS `payment_method_types: ["card"]`, WHICH SILENTLY DISABLED
        // APPLE PAY ON THIS SCREEN.
        //
        // Naming the types explicitly overrides the account's payment method
        // configuration, so the Payment Element rendered card-only - even on an
        // iPhone, even with the wallet domain registered at boot
        // (billing/paymentMethodDomains.ts) and the CSP fixed for Stripe's
        // wallet frames. Pay-ahead and deposit already used
        // `automatic_payment_methods` (billing/payments.ts) and DID show Apple
        // Pay; only card-on-file was left behind, so "Apple Pay is missing"
        // was true or false depending on which payment mode a shop ran.
        //
        // With automatic methods Stripe offers only what is compatible with
        // THIS intent - a SetupIntent with `usage: off_session` - so nothing
        // that cannot be saved and reused off-session can appear here. An
        // Apple Pay card saved this way yields an ordinary reusable payment
        // method, which is what services/cardOnFileSettle.ts later charges
        // under the shop's no-show policy. Nothing is charged today, and the
        // screen already says so.
        automatic_payment_methods: { enabled: true },
        description: input.description,
        metadata: { shopId: input.shopId, appointmentId: input.appointmentId, cardOnFileId },
      },
      { idempotencyKey: `seti-create:${cardOnFileId}` },
    );

    await runWithShop(input.shopId, (tx) =>
      tx.cardOnFile.create({
        data: {
          id: cardOnFileId,
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          stripeCustomerId: customer.id,
          stripeSetupIntentId: intent.id,
          status: "pending",
        },
      }),
    );
    return intent.client_secret ? { clientSecret: intent.client_secret, cardOnFileId } : null;
  } catch (err) {
    logger.error(
      { appointmentId: input.appointmentId, ...stripeErrorFacts(err) },
      "createCardOnFileSetupIntent failed",
    );
    return null;
  }
}

/**
 * The card is attached. Record what Stripe told us (payment method id, brand,
 * last4 - all outside PCI scope, all verbatim) and promote the hold.
 * Idempotent: a replayed webhook or a verify racing the webhook is a no-op.
 */
export async function markCardSaved(
  si: Stripe.SetupIntent,
  opts: { eventId?: string } = {},
): Promise<"saved" | "already" | "unknown" | "not_succeeded"> {
  if (si.status !== "succeeded") return "not_succeeded";
  const cardOnFileId = si.metadata?.cardOnFileId;
  const shopId = si.metadata?.shopId;
  const appointmentId = si.metadata?.appointmentId;
  if (!cardOnFileId || !shopId || !appointmentId) return "unknown";

  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  let brand: string | null = null;
  let last4: string | null = null;
  if (pmId) {
    try {
      const pm = await stripeClient().paymentMethods.retrieve(pmId);
      brand = pm.card?.brand ?? null;
      last4 = pm.card?.last4 ?? null;
    } catch (err) {
      logger.warn(
        { cardOnFileId, ...stripeErrorFacts(err) },
        "card on file: could not read the card's brand/last4",
      );
    }
  }

  const updated = await runWithShop(shopId, (tx) =>
    tx.cardOnFile.updateMany({
      where: { id: cardOnFileId, status: "pending" },
      data: {
        status: "saved",
        savedAt: new Date(),
        stripePaymentMethodId: pmId ?? null,
        brand,
        last4,
        ...(opts.eventId ? { lastWebhookEventId: opts.eventId } : {}),
      },
    }),
  );
  if (updated.count === 0) return "already";

  // Same promotion the deposit flow uses. On "lapsed"/"slot_taken" there is
  // nothing to refund (nothing was charged); release the card instead.
  const { promotePaidHold } = await import("../services/appointmentPaymentHold.js");
  const outcome = await promotePaidHold({ appointmentId });
  if (outcome === "lapsed" || outcome === "slot_taken") {
    await releaseCardOnFile({ shopId, appointmentId, reason: outcome });
  }
  return "saved";
}

/**
 * The browser says the SetupIntent succeeded. Do not take its word for it:
 * retrieve the intent and run the same path the webhook would.
 */
export async function verifyCardSaved(params: {
  shopId: string;
  appointmentId: string;
}): Promise<"saved" | "already" | "pending" | "unknown"> {
  const row = await runWithShop(params.shopId, (tx) =>
    tx.cardOnFile.findUnique({
      where: { appointmentId: params.appointmentId },
      select: { stripeSetupIntentId: true, status: true },
    }),
  );
  if (!row) return "unknown";
  if (row.status !== "pending") return "already";
  const si = await stripeClient().setupIntents.retrieve(row.stripeSetupIntentId);
  const r = await markCardSaved(si);
  return r === "not_succeeded" ? "pending" : r === "unknown" ? "unknown" : r;
}

/**
 * Let go of the card: detach the payment method (so nothing can ever charge it
 * again) and mark the row released. Called when the appointment completes or
 * is cancelled without a fee, or when its hold lapsed. Best-effort on the
 * Stripe side; the row is always marked.
 */
export async function releaseCardOnFile(params: {
  shopId: string;
  appointmentId: string;
  reason: string;
}): Promise<void> {
  const row = await runWithShop(params.shopId, (tx) =>
    tx.cardOnFile.findUnique({
      where: { appointmentId: params.appointmentId },
      select: { id: true, status: true, stripePaymentMethodId: true },
    }),
  );
  if (!row || row.status === "released" || row.status === "charged") return;
  if (row.stripePaymentMethodId) {
    try {
      await stripeClient().paymentMethods.detach(row.stripePaymentMethodId);
    } catch (err) {
      logger.warn(
        { cardOnFileId: row.id, ...stripeErrorFacts(err) },
        "card on file: detach failed (already detached?)",
      );
    }
  }
  await runWithShop(params.shopId, (tx) =>
    tx.cardOnFile.update({
      where: { id: row.id },
      data: { status: "released", releasedAt: new Date() },
    }),
  );
  logger.info({ cardOnFileId: row.id, reason: params.reason }, "card on file released");
}

function cryptoRandomId(): string {
  // Same shape as Payment ids: a stable prefix so a log line says what it is.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `cof_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type ChargeOutcome =
  | { outcome: "charged"; paymentId: string; cents: number }
  | { outcome: "declined"; paymentId: string; reason: string }
  /** Stripe did not answer. The card stays `charging`; the reconciler decides. */
  | { outcome: "ambiguous"; paymentId: string }
  | { outcome: "no_card" }
  | { outcome: "nothing_to_charge" }
  | { outcome: "already" }
  | { outcome: "error"; reason: string };

/**
 * Charge the card kept at booking. The ONLY path that ever charges a card on
 * file, and it runs only when the shop switched fees on and the appointment
 * ended on the customer: a no-show mark, or a cancel inside the window.
 *
 * 🔴 TWO MARKS, ONE CHARGE. The CardOnFile row's status is the compare-and-swap:
 * `saved -> charging` succeeds for exactly one caller, so two barbers tapping
 * "no-show" together (or a retry racing the first) cannot charge twice. The
 * Stripe idempotency key is keyed on the row too, as a second wall.
 *
 * A fresh off-session PaymentIntent (customer + saved payment_method,
 * off_session + confirm), destination charge like every other customer charge.
 * A decline is recorded, never retried automatically, and the barber is told -
 * the fee becomes something to collect at the next visit, not a silent loss.
 * Never throws: the no-show mark and the cancel must complete regardless.
 */
export async function chargeCardOnFile(params: {
  shopId: string;
  appointmentId: string;
  cents: number;
  reason: CardOnFileChargeReason;
  description: string;
}): Promise<ChargeOutcome> {
  if (params.cents <= 0) return { outcome: "nothing_to_charge" };
  try {
    const claimed = await runWithShop(params.shopId, async (tx) => {
      const row = await tx.cardOnFile.findUnique({
        where: { appointmentId: params.appointmentId },
        select: { id: true, status: true, stripeCustomerId: true, stripePaymentMethodId: true },
      });
      if (!row || !row.stripePaymentMethodId) return null;
      if (row.status !== "saved") return { row, won: false } as const;
      const cas = await tx.cardOnFile.updateMany({
        where: { id: row.id, status: "saved" },
        data: { status: "charging" },
      });
      return { row, won: cas.count === 1 } as const;
    });
    if (!claimed) return { outcome: "no_card" };
    if (!claimed.won) return { outcome: "already" };
    const { row } = claimed;
    // Narrowed inside the tx above; TypeScript loses it across the return.
    const paymentMethodId = row.stripePaymentMethodId;
    if (!paymentMethodId) {
      await setStatus(params.shopId, row.id, "saved");
      return { outcome: "no_card" };
    }

    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: { stripeConnectAccountId: true, platformFeeBps: true },
    });
    if (!shop?.stripeConnectAccountId) {
      await setStatus(params.shopId, row.id, "saved");
      return { outcome: "error", reason: "no_connect_account" };
    }
    const feeAmount = Math.floor((params.cents * shop.platformFeeBps) / 10000);
    const paymentId = `pay_${randomHex(24)}`;
    await runWithShop(params.shopId, (tx) =>
      tx.payment.create({
        data: {
          id: paymentId,
          shopId: params.shopId,
          appointmentId: params.appointmentId,
          stripePaymentIntentId: `pending:${paymentId}`,
          stripeConnectAccountId: shop.stripeConnectAccountId!,
          mode: "card_on_file",
          amount: params.cents,
          currency: "usd",
          applicationFeeAmount: feeAmount,
          status: "requires_confirmation",
        },
      }),
    );

    try {
      const pi = await stripeClient().paymentIntents.create(
        {
          amount: params.cents,
          currency: "usd",
          customer: row.stripeCustomerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          on_behalf_of: shop.stripeConnectAccountId,
          transfer_data: { destination: shop.stripeConnectAccountId },
          ...(feeAmount > 0 ? { application_fee_amount: feeAmount } : {}),
          description: params.description,
          metadata: {
            shopId: params.shopId,
            appointmentId: params.appointmentId,
            paymentId,
            cardOnFileId: row.id,
            reason: params.reason,
          },
        },
        { idempotencyKey: `cof-charge:${row.id}` },
      );
      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
      await runWithShop(params.shopId, async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            stripePaymentIntentId: pi.id,
            status: pi.status,
            ...(chargeId ? { stripeChargeId: chargeId } : {}),
            ...(pi.status === "succeeded" ? { capturedAmount: pi.amount_received } : {}),
          },
        });
        await tx.cardOnFile.update({
          where: { id: row.id },
          data: { status: pi.status === "succeeded" ? "charged" : "failed" },
        });
      });
      return pi.status === "succeeded"
        ? { outcome: "charged", paymentId, cents: params.cents }
        : { outcome: "declined", paymentId, reason: pi.status };
    } catch (err) {
      const facts = stripeErrorFacts(err);
      if (!facts.definitive) {
        // 🔴 AMBIGUOUS. A timeout or a dropped socket after the request may
        // have been accepted: the customer's card may be charged right now
        // while nothing here says so. Calling that "declined" would tell the
        // barber to collect the fee at the chair - a second time. The row
        // stays `charging` (so nothing can charge it again - the CAS holds),
        // the Payment is marked ambiguous, and the reconciler reads Stripe's
        // own answer. A retry of the same request would reuse the same
        // idempotency key, which is exactly what the reconciler does.
        await runWithShop(params.shopId, (tx) =>
          tx.payment.update({ where: { id: paymentId }, data: { ambiguousAt: new Date() } }),
        );
        logger.error(
          { appointmentId: params.appointmentId, cardOnFileId: row.id, paymentId, ...facts },
          "card on file: charge outcome unknown - left charging for the reconciler",
        );
        return { outcome: "ambiguous", paymentId };
      }
      // Stripe refuses an off-session charge with a card error whose
      // payment_intent (when present) carries the decline. Record and move on.
      const reason = stripeErrorCode(err);
      const piId = stripeErrorIntentId(err);
      await runWithShop(params.shopId, async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: "failed", ...(piId ? { stripePaymentIntentId: piId } : {}) },
        });
        await tx.cardOnFile.update({ where: { id: row.id }, data: { status: "failed" } });
      });
      logger.warn(
        { appointmentId: params.appointmentId, reason, requestId: facts.requestId },
        "card on file: charge declined",
      );
      return { outcome: "declined", paymentId, reason };
    }
  } catch (err) {
    logger.error(
      { appointmentId: params.appointmentId, errName: errorClassification(err) },
      "chargeCardOnFile failed",
    );
    return { outcome: "error", reason: errorClassification(err) };
  }
}

async function setStatus(shopId: string, id: string, status: string): Promise<void> {
  await runWithShop(shopId, (tx) => tx.cardOnFile.update({ where: { id }, data: { status } }));
}

function stripeErrorCode(err: unknown): string {
  const e = err as { code?: string; decline_code?: string; message?: string } | null;
  return e?.decline_code ?? e?.code ?? e?.message ?? "unknown";
}

function stripeErrorIntentId(err: unknown): string | null {
  const e = err as { payment_intent?: { id?: string } } | null;
  return e?.payment_intent?.id ?? null;
}


function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
