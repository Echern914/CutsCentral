import {
  CARD_FEE_APPROVAL_DAYS,
  cardDeclineWords,
  cardOnFileFeeCents,
  type CancellationTerms,
  type CardOnFileChargeReason,
  type NoShowChargeResult,
} from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { chargeCardOnFile, releaseCardOnFile } from "../billing/cardOnFile.js";
import { agreedPriceCents } from "./appointmentPriceLedger.js";
import { toCents as configToCents } from "../billing/payments.js";
import { sendEmail } from "../messaging/email.js";
import { buildCardChargedEmail } from "../messaging/templates.js";
import { appointmentDeepLink, sendToBarber } from "./barberNotify.js";

/**
 * What happens to a KEPT card when the appointment ends without being paid at
 * the chair: a no-show, or a cancellation.
 *
 * 🔴 THE RULE, IN ERIC'S WORDS: "card on file doesn't get charged unless the
 * barber is set and it's on them." Both halves are checked here and nowhere
 * else:
 *   - "the barber is set": card fees were ON and a fee configured in the terms
 *     THIS BOOKING was made on (the fee formula returns 0 otherwise) - its own
 *     snapshot, so switching fees on later never reaches a booking made while
 *     they were off; a booking from before snapshots reads the shop's current
 *     settings, as it always did (services/cancellationTerms.ts);
 *   - "it's on them": the outcome is a NO_SHOW, or a cancellation the CUSTOMER
 *     made inside that cancellation window (`applyPolicyFee`, which only the
 *     customer-facing cancel paths pass). A barber cancelling never charges.
 * Anything else RELEASES the card - it is detached and can never be charged.
 *
 * Runs after the cancel/no-show transaction has committed (Stripe is a network
 * call; never inside a tx), and never throws: the mark itself must stand.
 */
export type SettleResult =
  | { action: "charged"; cents: number; reason: CardOnFileChargeReason }
  | { action: "declined"; cents: number; reason: CardOnFileChargeReason; code: string }
  /** Stripe refused the request, not the card; the card is back to `saved` (a missing payment account leaves it saved too). */
  | { action: "setup_problem"; cents: number; reason: CardOnFileChargeReason }
  /** Stripe's answer never arrived; the reconciler will read it. */
  | { action: "pending"; cents: number; reason: CardOnFileChargeReason }
  /** Waiting for the barber to Charge or Waive (Shop.cardFeeNeedsApproval); the card is kept. */
  | { action: "held"; cents: number; reason: CardOnFileChargeReason }
  | { action: "released"; why: string }
  | { action: "none"; why?: "no_card" | "already" };

/**
 * settleCardOnFile's result as the barber reads it after marking a no-show
 * (`describeNoShowChargeResult` in config/shopPolicy.ts words it). Null when
 * there is nothing to say beyond "Marked no-show".
 */
export function noShowChargeResult(result: SettleResult): NoShowChargeResult | null {
  switch (result.action) {
    case "charged":
      return { kind: "charged", cents: result.cents };
    case "declined":
      return { kind: "declined", cents: result.cents, code: result.code };
    case "setup_problem":
      return { kind: "setup_problem", cents: result.cents };
    case "pending":
      return { kind: "pending", cents: result.cents };
    case "held":
      // Only a client's own cancel is held, and no barber waits on its answer.
      return null;
    case "released":
      return { kind: "not_charged", why: result.why === "fees_off" ? "fees_off" : "no_fee_due" };
    case "none":
      return result.why ? { kind: "not_charged", why: result.why } : null;
  }
}

export async function settleCardOnFile(params: {
  shopId: string;
  appointmentId: string;
  outcome: "CANCELED" | "NO_SHOW";
  /** True only on customer-initiated cancels (manage page, receptionist). */
  applyPolicyFee: boolean;
  /**
   * The BARBER said yes to this fee: their own "Client cancelled - charge $X"
   * tap. Only that path sets it. Without it, a shop that approves fees first
   * (Shop.cardFeeNeedsApproval) holds a late-cancel fee for the barber
   * instead of charging it.
   */
  barberApproved?: boolean;
  priceAtBooking: unknown;
  serviceName: string | null;
  startsAt: Date;
  now: Date;
  /**
   * The cancellation terms THIS booking was made on (services/
   * cancellationTerms.ts termsForBooking) - never the shop's settings today.
   * Required: a caller that forgets it does not compile.
   */
  terms: CancellationTerms;
}): Promise<SettleResult> {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: {
        name: true,
        timezone: true,
        ownerId: true,
        cardFeeNeedsApproval: true,
      },
    });
    if (!shop) return { action: "none" };

    const onThem =
      params.outcome === "NO_SHOW" || (params.outcome === "CANCELED" && params.applyPolicyFee);
    const reason: CardOnFileChargeReason = params.outcome === "NO_SHOW" ? "no_show" : "late_cancel";
    const cents = onThem
      ? await cardOnFileFeeFor({
          shopId: params.shopId,
          appointmentId: params.appointmentId,
          priceAtBooking: params.priceAtBooking,
          startsAt: params.startsAt,
          now: params.now,
          reason,
          terms: params.terms,
        })
      : 0;

    if (cents <= 0) {
      const why = !params.terms.chargeCardOnFileFees
        ? "fees_off"
        : !onThem
          ? "not_on_customer"
          : "no_fee_due";
      await releaseCardOnFile({ shopId: params.shopId, appointmentId: params.appointmentId, reason: why });
      return { action: "released", why };
    }

    // 🔴 THE BARBER APPROVES IT FIRST (Shop.cardFeeNeedsApproval). The CLIENT
    // cancelled - nobody at the shop has said yes to this charge - so it waits
    // on the appointment for Charge or Waive and the card is kept. The barber's
    // own late-cancel tap says `barberApproved`; a no-show is only ever marked
    // by the barber. Fail-safe: a new customer cancel path that forgets the
    // flag holds the fee rather than charging it.
    if (
      params.outcome === "CANCELED" &&
      params.applyPolicyFee &&
      params.barberApproved !== true &&
      shop.cardFeeNeedsApproval
    ) {
      const held = await holdCardFeeForApproval({
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        ownerId: shop.ownerId,
        timezone: shop.timezone,
        cents,
        now: params.now,
      });
      return held ? { action: "held", cents, reason } : { action: "none", why: "already" };
    }

    return await chargeFeeAndTell({
      shopId: params.shopId,
      appointmentId: params.appointmentId,
      shop,
      cents,
      reason,
      serviceName: params.serviceName,
      startsAt: params.startsAt,
    });
  } catch (err) {
    logger.error({ err, appointmentId: params.appointmentId }, "settleCardOnFile failed");
    return { action: "none" };
  }
}

/**
 * Charge a kept card a fee already decided on, and tell whoever has to know:
 * the client when it went through, the barber when it did not. Shared by the
 * settlement above and by the barber's Charge on a fee that waited for them
 * (services/cardFeeApproval.ts), so an approved fee is taken and announced
 * exactly as an immediate one is.
 */
export async function chargeFeeAndTell(params: {
  shopId: string;
  appointmentId: string;
  shop: { name: string; timezone: string; ownerId: string };
  cents: number;
  reason: CardOnFileChargeReason;
  serviceName: string | null;
  startsAt: Date;
}): Promise<SettleResult> {
  const { shop, cents, reason } = params;
  try {
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
      return { action: "pending", cents, reason };
    }
    if (charged.outcome === "setup_problem" || charged.outcome === "error") {
      // Not the card: Stripe refused the request, or the shop has no payment
      // account to send the money to. Never "collect it at the next visit" -
      // the barber is told it is on ChairBack's side, and chargeCardOnFile
      // logged it at error for us.
      await tellBarberSetupProblem({
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        ownerId: shop.ownerId,
        cents,
        reason,
      });
      return { action: "setup_problem", cents, reason };
    }
    if (charged.outcome === "no_card" || charged.outcome === "already") {
      return { action: "none", why: charged.outcome };
    }
    // nothing_to_charge: unreachable past the cents check above.
    return { action: "none" };
  } catch (err) {
    logger.error({ err, appointmentId: params.appointmentId }, "card on file: fee charge failed");
    return { action: "none" };
  }
}

/**
 * Put a client's late-cancel fee in front of the barber instead of charging
 * it (Shop.cardFeeNeedsApproval). Writes the figure onto the appointment - a
 * compare-and-set on "nothing waiting, nothing waived", so a retried cancel
 * never re-opens a fee the barber already decided - and tells the barber.
 * The card is NOT released: it is what the fee will be charged to. False when
 * a fee was already waiting or decided.
 */
export async function holdCardFeeForApproval(params: {
  shopId: string;
  appointmentId: string;
  ownerId: string;
  timezone: string;
  cents: number;
  now: Date;
}): Promise<boolean> {
  const held = await runWithShop(params.shopId, (tx) =>
    tx.appointment.updateMany({
      where: {
        id: params.appointmentId,
        shopId: params.shopId,
        cardFeeAwaitingSince: null,
        cardFeeWaivedAt: null,
      },
      data: { cardFeeAwaitingCents: params.cents, cardFeeAwaitingSince: params.now },
    }),
  );
  if (held.count === 0) return false;
  logger.info(
    { shopId: params.shopId, appointmentId: params.appointmentId, cents: params.cents },
    "card on file: late-cancel fee waiting for the barber",
  );
  const appt = await runWithShop(params.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: params.appointmentId, shopId: params.shopId },
      select: {
        firstName: true,
        lastName: true,
        startsAt: true,
        staff: { select: { userId: true } },
      },
    }),
  );
  const who = [appt?.firstName, appt?.lastName].filter(Boolean).join(" ") || "A client";
  await sendToBarber({
    shopId: params.shopId,
    userId: appt?.staff?.userId ?? params.ownerId,
    kind: "cancel",
    message: {
      title: `Charge ${who}'s late-cancel fee?`,
      body: `${who} cancelled inside your cutoff. Nothing is charged until you say so: open it to charge the $${(params.cents / 100).toFixed(2)} fee or waive it. If you do neither in ${CARD_FEE_APPROVAL_DAYS} days, the card is let go.`,
      tag: `cof-approve-${params.appointmentId}`,
      ...(appt
        ? { url: appointmentDeepLink(params.appointmentId, { startsAt: appt.startsAt, timezone: params.timezone }) }
        : {}),
    },
  }).catch((err: unknown) => {
    logger.warn({ err, appointmentId: params.appointmentId }, "card on file: approval alert failed");
  });
  return true;
}

/**
 * What a card kept on THIS booking is charged for `reason` at `now`, in cents
 * - the figure settleCardOnFile charges, for every surface that has to SAY it
 * first (the client's appointment page before Cancel, the receptionist).
 * Zero when this booking's terms switch card fees off or set no fee.
 *
 * THE FEE BASIS IS WHAT THE CUSTOMER AGREED TO. The ticket can be corrected
 * by hand after booking (POST /appointments/:id/price); a ticket RAISED after
 * the customer saved their card must never raise the fee they consented to at
 * the old one. The ledger's first entry remembers the price before any edit;
 * a lowered ticket lowers the fee.
 */
export async function cardOnFileFeeFor(params: {
  shopId: string;
  appointmentId: string;
  priceAtBooking: unknown;
  startsAt: Date;
  now: Date;
  reason: CardOnFileChargeReason;
  terms: CancellationTerms;
}): Promise<number> {
  if (!params.terms.chargeCardOnFileFees) return 0;
  const currentCents = configToCents(numberOrNull(params.priceAtBooking));
  const priceCents = await agreedPriceCents(params.shopId, params.appointmentId, currentCents);
  return cardOnFileFeeCents({
    priceCents,
    cancelWindowHours: params.terms.cancelWindowHours,
    cancelFeeBps: params.terms.cancelFeeBps,
    cardFeeFlatCents: params.terms.cardFeeFlatCents,
    startsAt: params.startsAt,
    now: params.now,
    reason: params.reason,
  });
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
      // The code in words (cardDeclineWords), never Stripe's own text.
      body: `The $${dollars} ${why} fee was declined: ${cardDeclineWords(params.code)}. Collect it at their next visit.`,
      tag: `cof-declined-${params.appointmentId}`,
    },
  });
}

/**
 * The fee could not be charged for a reason that is NOT the card - Stripe
 * refused the request, or the shop's payment account is missing. Same alert
 * family as a decline, different instruction: the card was not refused, and
 * collecting at the next visit is not the answer.
 */
async function tellBarberSetupProblem(params: {
  shopId: string;
  appointmentId: string;
  ownerId: string;
  cents: number;
  reason: CardOnFileChargeReason;
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
      body: `The $${dollars} ${why} fee couldn't be charged because of a payment setup problem on ChairBack's side, not the card. ChairBack has been alerted and will look into it.`,
      tag: `cof-setup-${params.appointmentId}`,
    },
  });
}
