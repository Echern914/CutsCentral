import type Stripe from "stripe";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";

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
        payment_method_types: ["card"],
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
    logger.error({ err, appointmentId: input.appointmentId }, "createCardOnFileSetupIntent failed");
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
      logger.warn({ err, cardOnFileId }, "card on file: could not read the card's brand/last4");
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
      logger.warn({ err, cardOnFileId: row.id }, "card on file: detach failed (already detached?)");
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
