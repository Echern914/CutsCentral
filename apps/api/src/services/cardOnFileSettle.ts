import { cardOnFileFeeCents, type CardOnFileChargeReason } from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { chargeCardOnFile, releaseCardOnFile } from "../billing/cardOnFile.js";
import { agreedPriceCents } from "./appointmentPriceLedger.js";
import { toCents as configToCents } from "../billing/payments.js";
import { sendEmail } from "../messaging/email.js";
import { buildCardChargedEmail } from "../messaging/templates.js";
import { sendToBarber } from "./barberNotify.js";

/**
 * What happens to a KEPT card when the appointment ends without being paid at
 * the chair: a no-show, or a cancellation.
 *
 * 🔴 THE RULE, IN ERIC'S WORDS: "card on file doesn't get charged unless the
 * barber is set and it's on them." Both halves are checked here and nowhere
 * else:
 *   - "the barber is set": Shop.chargeCardOnFileFees is ON and a fee is
 *     configured (the fee formula returns 0 otherwise);
 *   - "it's on them": the outcome is a NO_SHOW, or a cancellation the CUSTOMER
 *     made inside the shop's cancellation window (`applyPolicyFee`, which only
 *     the customer-facing cancel paths pass). A barber cancelling never charges.
 * Anything else RELEASES the card - it is detached and can never be charged.
 *
 * Runs after the cancel/no-show transaction has committed (Stripe is a network
 * call; never inside a tx), and never throws: the mark itself must stand.
 */
export type SettleResult =
  | { action: "charged"; cents: number; reason: CardOnFileChargeReason }
  | { action: "declined"; cents: number; reason: CardOnFileChargeReason; code: string }
  | { action: "released"; why: string }
  | { action: "none" };

export async function settleCardOnFile(params: {
  shopId: string;
  appointmentId: string;
  outcome: "CANCELED" | "NO_SHOW";
  /** True only on customer-initiated cancels (manage page, receptionist). */
  applyPolicyFee: boolean;
  priceAtBooking: unknown;
  serviceName: string | null;
  startsAt: Date;
  now: Date;
}): Promise<SettleResult> {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: {
        name: true,
        timezone: true,
        ownerId: true,
        paymentsMode: true,
        chargeCardOnFileFees: true,
        cancelWindowHours: true,
        cancelFeeBps: true,
      },
    });
    if (!shop) return { action: "none" };

    const onThem =
      params.outcome === "NO_SHOW" || (params.outcome === "CANCELED" && params.applyPolicyFee);
    const reason: CardOnFileChargeReason = params.outcome === "NO_SHOW" ? "no_show" : "late_cancel";
    // THE FEE BASIS IS WHAT THE CUSTOMER AGREED TO. The ticket can be corrected
    // by hand after booking (POST /appointments/:id/price); a ticket RAISED
    // after the customer saved their card must never raise the fee they
    // consented to at the old one. The ledger's first entry remembers the
    // price before any edit; a lowered ticket lowers the fee.
    const currentCents = configToCents(numberOrNull(params.priceAtBooking));
    const priceCents = await agreedPriceCents(params.shopId, params.appointmentId, currentCents);
    const cents =
      shop.chargeCardOnFileFees && onThem
        ? cardOnFileFeeCents({
            priceCents,
            cancelWindowHours: shop.cancelWindowHours,
            cancelFeeBps: shop.cancelFeeBps,
            startsAt: params.startsAt,
            now: params.now,
            reason,
          })
        : 0;

    if (cents <= 0) {
      const why = !shop.chargeCardOnFileFees
        ? "fees_off"
        : !onThem
          ? "not_on_customer"
          : "no_fee_due";
      await releaseCardOnFile({ shopId: params.shopId, appointmentId: params.appointmentId, reason: why });
      return { action: "released", why };
    }

    const what = params.serviceName ?? "your appointment";
    const charged = await chargeCardOnFile({
      shopId: params.shopId,
      appointmentId: params.appointmentId,
      cents,
      reason,
      description:
        reason === "no_show"
          ? `No-show fee for ${what} at ${shop.name}`
          : `Late cancellation fee for ${what} at ${shop.name}`,
    });

    if (charged.outcome === "charged") {
      await tellCustomer({ ...params, shopName: shop.name, timezone: shop.timezone, cents, reason });
      return { action: "charged", cents, reason };
    }
    if (charged.outcome === "declined") {
      await tellBarber({
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        ownerId: shop.ownerId,
        cents,
        reason,
        code: charged.reason,
      });
      return { action: "declined", cents, reason, code: charged.reason };
    }
    if (charged.outcome === "ambiguous") {
      // Stripe may or may not have taken the money. Nobody is told anything -
      // not "charged" to the customer, not "declined, collect it at the next
      // visit" to the barber - until the reconciler has read Stripe's own
      // answer. Telling the barber "declined" here is how a fee gets collected
      // twice.
      logger.error(
        { appointmentId: params.appointmentId, paymentId: charged.paymentId },
        "card on file: charge outcome unknown - waiting for the reconciler before anyone is told",
      );
      return { action: "none" };
    }
    // no_card / already / nothing_to_charge / error: nothing more to do here;
    // chargeCardOnFile logged the specifics.
    return { action: "none" };
  } catch (err) {
    logger.error({ err, appointmentId: params.appointmentId }, "settleCardOnFile failed");
    return { action: "none" };
  }
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "Your card ending 4242 was charged $20" - the customer must hear it from us. */
async function tellCustomer(params: {
  shopId: string;
  appointmentId: string;
  shopName: string;
  timezone: string;
  serviceName: string | null;
  startsAt: Date;
  cents: number;
  reason: CardOnFileChargeReason;
}): Promise<void> {
  const appt = await runWithShop(params.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: params.appointmentId, shopId: params.shopId },
      select: {
        firstName: true,
        email: true,
        manageToken: true,
        client: { select: { email: true } },
        cardOnFile: { select: { brand: true, last4: true } },
      },
    }),
  );
  const to = appt?.email ?? appt?.client?.email ?? null;
  if (!appt || !to) {
    logger.info({ appointmentId: params.appointmentId }, "card on file: charged, no email to tell");
    return;
  }
  const email = buildCardChargedEmail({
    firstName: appt.firstName,
    shopName: params.shopName,
    serviceName: params.serviceName ?? "your appointment",
    startsAt: params.startsAt,
    timezone: params.timezone,
    cents: params.cents,
    reason: params.reason,
    brand: appt.cardOnFile?.brand ?? null,
    last4: appt.cardOnFile?.last4 ?? null,
    manageToken: appt.manageToken,
  });
  try {
    await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: params.shopName,
      stream: "transactional",
      meta: { shopId: params.shopId, kind: "card_charged", appointmentId: params.appointmentId },
    });
  } catch (err) {
    logger.error({ err, appointmentId: params.appointmentId }, "card on file: charged-email send failed");
  }
}

/**
 * A decline is not a silent loss: the fee becomes something to collect at the
 * next visit, and the barber has to know that. Rides the "cancel" alert switch
 * on purpose - it is the same family (something happened to a booking), and a
 * new switch would mean a new column + settings row for an event most shops
 * will see a few times a year.
 */
async function tellBarber(params: {
  shopId: string;
  appointmentId: string;
  ownerId: string;
  cents: number;
  reason: CardOnFileChargeReason;
  code: string;
}): Promise<void> {
  const appt = await runWithShop(params.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: params.appointmentId, shopId: params.shopId },
      select: { firstName: true, lastName: true, staff: { select: { userId: true } } },
    }),
  );
  const who = [appt?.firstName, appt?.lastName].filter(Boolean).join(" ") || "A customer";
  const dollars = (params.cents / 100).toFixed(2);
  const why = params.reason === "no_show" ? "no-show" : "late cancellation";
  await sendToBarber({
    shopId: params.shopId,
    userId: appt?.staff?.userId ?? params.ownerId,
    kind: "cancel",
    message: {
      title: `Couldn't charge ${who}'s card`,
      body: `The $${dollars} ${why} fee was declined (${params.code}). Collect it at their next visit.`,
      tag: `cof-declined-${params.appointmentId}`,
    },
  });
}
