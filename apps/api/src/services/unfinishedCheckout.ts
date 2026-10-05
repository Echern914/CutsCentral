import { prisma, runWithShop } from "@chairback/db";
import { stripeClient } from "../billing/stripe.js";
import { isPendingIntentId } from "../billing/payments.js";
import { logger } from "../logger.js";

/**
 * THE CARD STEP OF A BOOKING THAT IS STILL WAITING FOR IT.
 *
 * A shop that takes a card (or a deposit) writes the booking as a ten-minute
 * hold and shows the card form. Customers left that form thinking they were
 * booked - "Done" in the iPhone app goes straight back to their list, where it
 * read "Requested" - and when the ten minutes ran out the time went back on
 * sale with nobody told. There was no way back to the form: the manage page
 * showed the status and nothing else.
 *
 * This hands the SAME card step back - the same SetupIntent or PaymentIntent,
 * so nothing is created twice and a card saved here promotes the hold exactly
 * as it would have on the booking page (card-saved / the webhook).
 *
 * 🔴 ONLY WHILE THE HOLD IS LIVE. After the deadline the time may already be
 * someone else's, and the sweep has released (or is about to release) the
 * card; offering the form then would take a card for nothing. The token is the
 * authority, as for every other manage action: whoever holds the link is the
 * person who started this booking.
 */

export interface UnfinishedCheckout {
  /** "setup" = card kept, nothing charged. "payment" = money moves (pay ahead / deposit). */
  kind: "setup" | "payment";
  clientSecret: string;
  amountCents: number;
  isDeposit: boolean;
  balanceDueCents: number;
  /** When the time goes back on sale. */
  expiresAt: string;
  /**
   * Card on file only: the customer already agreed, on the booking page, that
   * the shop may charge this card for the service. The resumed screen must say
   * the same thing the first one did - never "charged only for a no-show" to
   * someone who agreed to more.
   */
  serviceChargeConsent: boolean;
  /**
   * The payment is on non-refundable terms (its own snapshot): the resumed
   * screen must say so, exactly as the first one did.
   */
  nonRefundable: boolean;
}

/** Intent states that still want the customer's card. */
const AWAITING = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

export async function unfinishedCheckoutFor(
  appt: {
    id: string;
    shopId: string;
    status: string;
    holdReason: string | null;
    holdExpiresAt: Date | null;
    priceAtBooking: { toString(): string } | null;
  },
  now: Date,
): Promise<UnfinishedCheckout | null> {
  if (appt.status !== "PENDING" || appt.holdReason !== "payment") return null;
  if (!appt.holdExpiresAt || appt.holdExpiresAt.getTime() <= now.getTime()) return null;
  const expiresAt = appt.holdExpiresAt.toISOString();
  const fullCents = appt.priceAtBooking === null ? 0 : Math.round(Number(appt.priceAtBooking.toString()) * 100);

  try {
    const card = await runWithShop(appt.shopId, (tx) =>
      tx.cardOnFile.findUnique({
        where: { appointmentId: appt.id },
        select: { stripeSetupIntentId: true, status: true, serviceChargeConsentAt: true },
      }),
    );
    if (card) {
      if (card.status !== "pending") return null;
      const si = await stripeClient().setupIntents.retrieve(card.stripeSetupIntentId);
      if (!si.client_secret || !AWAITING.has(si.status)) return null;
      return {
        kind: "setup",
        clientSecret: si.client_secret,
        amountCents: 0,
        isDeposit: false,
        balanceDueCents: fullCents,
        expiresAt,
        serviceChargeConsent: card.serviceChargeConsentAt !== null,
        nonRefundable: false,
      };
    }

    const payment = await prisma.payment.findFirst({
      where: { appointmentId: appt.id, purpose: "booking" },
      select: {
        stripePaymentIntentId: true,
        amount: true,
        nonRefundable: true,
        shop: { select: { paymentsMode: true } },
      },
    });
    if (!payment || isPendingIntentId(payment.stripePaymentIntentId)) return null;
    const pi = await stripeClient().paymentIntents.retrieve(payment.stripePaymentIntentId);
    if (!pi.client_secret || !AWAITING.has(pi.status)) return null;
    const isDeposit = payment.shop.paymentsMode === "deposit" && payment.amount < fullCents;
    return {
      kind: "payment",
      clientSecret: pi.client_secret,
      amountCents: payment.amount,
      isDeposit,
      balanceDueCents: Math.max(0, fullCents - payment.amount),
      expiresAt,
      serviceChargeConsent: false,
      nonRefundable: payment.nonRefundable,
    };
  } catch (err) {
    // Stripe unreachable: the page says what is true (not booked yet) and
    // simply cannot offer the form this time.
    logger.warn({ err, appointmentId: appt.id }, "unfinished checkout: could not reopen the card step");
    return null;
  }
}

/**
 * ADD A CARD TO A BOOKING THAT DOESN'T NEED ONE TO STAND.
 *
 * A card shop that books without a card (Shop.requireCardToBook off) confirms
 * at Confirm and offers the card step after it, optional. A client who skipped
 * it can add the card later from the booking's own link: the same SetupIntent,
 * so a card saved here is filed exactly as it would have been on the booking
 * page. Only for a booking still ahead, whose card never arrived.
 */
export async function optionalCardStepFor(
  appt: { id: string; shopId: string; status: string; startsAt: Date; seriesId: string | null },
  now: Date,
): Promise<{ clientSecret: string; serviceChargeConsent: boolean; chargesFees: boolean } | null> {
  if (appt.status !== "BOOKED" || appt.startsAt.getTime() <= now.getTime()) return null;
  try {
    const select = {
      stripeSetupIntentId: true,
      status: true,
      serviceChargeConsentAt: true,
      serviceChargeWithdrawnAt: true,
    } as const;
    // This visit's own card row - or, for a later visit of a standing
    // appointment, the series' one card, which lives on the first visit.
    const card =
      (await runWithShop(appt.shopId, (tx) =>
        tx.cardOnFile.findUnique({ where: { appointmentId: appt.id }, select }),
      )) ??
      (appt.seriesId
        ? await runWithShop(appt.shopId, (tx) =>
            tx.cardOnFile.findUnique({ where: { seriesId: appt.seriesId! }, select }),
          )
        : null);
    if (!card || card.status !== "pending") return null;
    const si = await stripeClient().setupIntents.retrieve(card.stripeSetupIntentId);
    if (!si.client_secret || !AWAITING.has(si.status)) return null;
    // Shop has RLS with no policy: read directly, never inside runWithShop.
    const shop = await prisma.shop.findUnique({
      where: { id: appt.shopId },
      select: { chargeCardOnFileFees: true },
    });
    return {
      clientSecret: si.client_secret,
      // Taken back on the appointment page: the panel must not repeat it.
      serviceChargeConsent: card.serviceChargeConsentAt !== null && card.serviceChargeWithdrawnAt === null,
      // The same fee terms the booking page's card step states.
      chargesFees: shop?.chargeCardOnFileFees === true,
    };
  } catch (err) {
    // Stripe unreachable: the booking stands; the page just can't offer the card this time.
    logger.warn({ err, appointmentId: appt.id }, "add a card: could not reopen the card step");
    return null;
  }
}

/**
 * A booking that was only ever a payment hold and never became one: the card
 * (or payment) did not arrive before the hold ran out, or a payment landed too
 * late and was refunded. A hold that turned into a booking loses its
 * `holdReason` when it is promoted, so a CANCELED row still carrying it was
 * never booked at all - which is what the customer needs to hear, in those
 * words, rather than "Canceled" (they never cancelled anything).
 */
export function neverBooked(appt: { status: string; holdReason: string | null }): boolean {
  return appt.status === "CANCELED" && appt.holdReason === "payment";
}
