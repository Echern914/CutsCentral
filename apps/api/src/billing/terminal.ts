import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { connectEnabled, stripeClient } from "./stripe.js";
import { isPendingIntentId, pendingIntentId, validateCharge } from "./payments.js";
import { errorClassification, stripeErrorFacts } from "./stripeErrors.js";

/**
 * Stripe Terminal — the server half of Tap to Pay on iPhone.
 *
 * Phase 1: everything here is exercisable against Stripe's SIMULATED reader, so
 * it is testable with no hardware, no iPhone, and before Apple grants the
 * `proximity-reader.payment.acceptance` entitlement. The native SDK half lands
 * once that entitlement is live.
 *
 * 🔑 APPLE TAKES NOTHING FROM THESE CHARGES. The entitlement is permission to
 * use the NFC hardware, not a revenue share — a haircut is a real-world service
 * and is expressly excluded from in-app purchase. Card → Stripe → the barber.
 *
 * CONNECT SHAPE. We use destination charges with `on_behalf_of` (see
 * payments.ts), so every Terminal call is made with the PLATFORM key and the
 * connected account rides on the PaymentIntent — not via a Stripe-Account
 * header. The mobile SDK must pass the same connected account id in its Tap to
 * Pay connection configuration, which is why /connection-token hands it back.
 */

export function terminalEnabled(): boolean {
  // Same seam as customer payments: no Stripe env, no Terminal.
  return connectEnabled();
}

/**
 * The shop's Terminal Location, created once and cached on the Shop row.
 *
 * A Location is REQUIRED before any reader may connect, Tap to Pay included.
 * Creating one per connection-token request would litter the Stripe account
 * with duplicates, so the id is persisted and reused.
 *
 * The address is deliberately the shop's own when it has one: Stripe shows it
 * in the dashboard and it is what makes a Location legible to the barber.
 * Address is required by Stripe, so an address-less shop falls back to the
 * country only — good enough to create the Location, and the barber can fix it
 * later without breaking anything already connected.
 */
export async function ensureTerminalLocation(shopId: string): Promise<string | null> {
  if (!terminalEnabled()) return null;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      stripeTerminalLocationId: true,
      addressStreet: true,
      addressCity: true,
      addressRegion: true,
      addressPostal: true,
    },
  });
  if (!shop) return null;
  if (shop.stripeTerminalLocationId) return shop.stripeTerminalLocationId;

  try {
    const location = await stripeClient().terminal.locations.create(
      {
        display_name: shop.name.slice(0, 100),
        address: {
          line1: shop.addressStreet || "Address on file",
          city: shop.addressCity || undefined,
          state: shop.addressRegion || undefined,
          postal_code: shop.addressPostal || undefined,
          country: "US",
        },
        metadata: { shopId: shop.id },
      },
      // Keyed on the shop so a double-tap during onboarding cannot create two.
      { idempotencyKey: `terminal-location:${shop.id}` },
    );
    await prisma.shop.update({
      where: { id: shop.id },
      data: { stripeTerminalLocationId: location.id },
    });
    return location.id;
  } catch (err) {
    logger.error({ shopId, ...stripeErrorFacts(err) }, "ensureTerminalLocation failed");
    return null;
  }
}

/**
 * A short-lived connection token for the mobile SDK.
 *
 * Created on the PLATFORM account (destination-charge model), so no
 * stripeAccount option. The token itself is not shop-scoped — the caller's
 * session is what authorizes it, and the route enforces that.
 */
export async function createConnectionToken(): Promise<string | null> {
  if (!terminalEnabled()) return null;
  try {
    const token = await stripeClient().terminal.connectionTokens.create();
    return token.secret;
  } catch (err) {
    logger.error({ ...stripeErrorFacts(err) }, "createConnectionToken failed");
    return null;
  }
}

export interface TerminalIntentInput {
  shopId: string;
  appointmentId: string;
  connectAccountId: string;
  amountCents: number;
  platformFeeBps: number;
  currency?: string;
  description?: string;
}

/**
 * A CARD-PRESENT PaymentIntent for a cut, plus its Payment row.
 *
 * Differs from the pay-ahead intent in exactly two ways that matter:
 *   - `payment_method_types: ["card_present"]` instead of automatic methods.
 *     Card-present is what the reader collects; leaving automatic methods on
 *     would let Stripe offer online-only methods a reader cannot fulfil.
 *   - `capture_method: "automatic"` — the cut is done and the money is owed
 *     now, so there is nothing to hold.
 *
 * 🔴 ONE PAYMENT ROW PER APPOINTMENT (unique constraint). If a pay-ahead charge
 * already exists for this cut we do NOT create a second — the caller gets a
 * clear refusal instead of a duplicate charge. Splitting a cut across an online
 * deposit AND a card-present balance needs Payment to become one-to-many, which
 * is deliberately out of scope here.
 */
export async function createTerminalPaymentIntent(
  input: TerminalIntentInput,
): Promise<
  | { ok: true; clientSecret: string; paymentIntentId: string; paymentId: string }
  | { ok: false; reason: "disabled" | "payment_exists" | "stripe_error" }
> {
  if (!terminalEnabled()) return { ok: false, reason: "disabled" };
  const currency = input.currency ?? "usd";
  const feeAmount = Math.floor((input.amountCents * input.platformFeeBps) / 10000);

  const existing = await prisma.payment.findUnique({
    where: { appointmentId: input.appointmentId },
    select: { id: true, stripePaymentIntentId: true, mode: true, status: true },
  });
  if (existing && !(existing.mode === "terminal" && isPendingIntentId(existing.stripePaymentIntentId))) {
    // A previous card-present attempt that never completed is resumable — the
    // reader dropped, the app crashed — so hand its intent back rather than
    // stranding the barber. Anything else (a real pay-ahead charge) is refused.
    // (A terminal row still on its `pending:` reservation id falls through to
    // the retry below, which re-issues the same request under the same key.)
    if (existing.mode === "terminal" && existing.status !== "succeeded") {
      try {
        const pi = await stripeClient().paymentIntents.retrieve(
          existing.stripePaymentIntentId,
        );
        if (pi.client_secret) {
          return {
            ok: true,
            clientSecret: pi.client_secret,
            paymentIntentId: pi.id,
            paymentId: existing.id,
          };
        }
      } catch (err) {
        logger.error(
          { appointmentId: input.appointmentId, ...stripeErrorFacts(err) },
          "terminal intent retrieve failed",
        );
      }
    }
    return { ok: false, reason: "payment_exists" };
  }

  const invalid = validateCharge(input.amountCents, currency);
  if (invalid) {
    logger.error(
      { appointmentId: input.appointmentId, reason: invalid },
      "createTerminalPaymentIntent refused: invalid amount or currency",
    );
    return { ok: false, reason: "stripe_error" };
  }

  try {
    // ROW FIRST, STRIPE SECOND - the same order as pay-ahead, for the same
    // reasons (see createAheadPaymentIntent). A terminal row whose intent was
    // never answered keeps its `pending:` id and is retried under the same key.
    const pendingRow =
      existing && isPendingIntentId(existing.stripePaymentIntentId) ? existing : null;
    const paymentId = pendingRow?.id ?? `pay_${randomHex(24)}`;
    if (!pendingRow) {
      await prisma.payment.create({
        data: {
          id: paymentId,
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          stripePaymentIntentId: pendingIntentId(paymentId),
          stripeConnectAccountId: input.connectAccountId,
          mode: "terminal",
          amount: input.amountCents,
          currency,
          applicationFeeAmount: feeAmount,
          status: "requires_payment_method",
        },
      });
    }

    try {
      const intent = await stripeClient().paymentIntents.create(
        {
          amount: input.amountCents,
          currency,
          payment_method_types: ["card_present"],
          capture_method: "automatic",
          on_behalf_of: input.connectAccountId,
          transfer_data: { destination: input.connectAccountId },
          ...(feeAmount > 0 ? { application_fee_amount: feeAmount } : {}),
          description: input.description,
          metadata: {
            shopId: input.shopId,
            appointmentId: input.appointmentId,
            paymentId,
          },
        },
        { idempotencyKey: `terminal-pi:${paymentId}` },
      );
      await prisma.payment.updateMany({
        where: { id: paymentId, stripePaymentIntentId: pendingIntentId(paymentId) },
        data: { stripePaymentIntentId: intent.id, status: intent.status, ambiguousAt: null },
      });
      return intent.client_secret
        ? { ok: true, clientSecret: intent.client_secret, paymentIntentId: intent.id, paymentId }
        : { ok: false, reason: "stripe_error" };
    } catch (err) {
      const facts = stripeErrorFacts(err);
      if (!facts.definitive) {
        await prisma.payment.updateMany({
          where: { id: paymentId },
          data: { ambiguousAt: new Date() },
        });
      }
      logger.error(
        { appointmentId: input.appointmentId, paymentId, ...facts },
        facts.definitive
          ? "createTerminalPaymentIntent refused by Stripe"
          : "createTerminalPaymentIntent outcome unknown - the reconciler owns it",
      );
      return { ok: false, reason: "stripe_error" };
    }
  } catch (err) {
    logger.error(
      { appointmentId: input.appointmentId, errName: errorClassification(err) },
      "createTerminalPaymentIntent failed",
    );
    return { ok: false, reason: "stripe_error" };
  }
}

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
