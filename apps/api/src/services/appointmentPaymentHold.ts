import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { ServiceDayFullError } from "../engines/serviceDailyLimit.js";
import { releaseForAppointment } from "../engines/acuityMirror.js";
import { refundForCancellation } from "../billing/payments.js";
import {
  notifyAppointmentConfirmation,
  notifyBarberBookingEvent,
} from "./appointmentNotify.js";

/**
 * PAYMENT HOLDS - the chair is held while the customer pays, and only becomes
 * a booking when the money actually lands.
 *
 * 🔴 WHY THIS EXISTS. A shop running deposits reported that "it still books
 * the appointments even though it says deposit required". It did. The booking
 * committed as BOOKED, the Acuity block went out, the confirmation email went
 * out and the barber's phone buzzed - and THEN the deposit screen appeared.
 * Closing the tab left a confirmed, unpaid appointment holding the chair, with
 * nothing anywhere that would ever reverse it: the payment webhook only ever
 * touched the Payment row, and no sweep looked for unpaid bookings.
 *
 * The order is now the one customers already expect from every other booking
 * site: hold the chair, take the money, THEN confirm.
 *
 * A payment hold is an ordinary PENDING row with holdExpiresAt set, so every
 * guard, the busy set and the slot grid treat it as taken with no changes.
 * holdReason distinguishes it from the AI receptionist's hold in the one place
 * that matters (shouldMirrorOnCreate - a payment hold IS mirrored to Acuity,
 * because a real customer is mid-checkout).
 */

/**
 * How long the chair is held while the customer pays.
 *
 * Ten minutes: long enough for Apple Pay, a re-entered card, a 3-D Secure
 * challenge and a fumbled CVV; short enough that a Saturday is not full of
 * ghosts. It is a ceiling, not a delay - the moment payment succeeds the hold
 * is promoted, and the moment it lapses the chair is free again.
 */
export const PAYMENT_HOLD_MINUTES = 10;

export function paymentHoldExpiry(now: Date): Date {
  return new Date(now.getTime() + PAYMENT_HOLD_MINUTES * 60_000);
}

/**
 * Will this booking take money before it becomes real?
 *
 * Pure and exported ON PURPOSE. It is the single decision that separates "hold
 * the chair while they pay" from "confirm it now", it has five independent
 * ways to be false, and the Stripe-touching code around it cannot be exercised
 * in this suite - so if it lived inline in the route it would ship untested.
 *
 * Every clause is a reason NOT to hold:
 *  - Connect not configured on the platform at all.
 *  - The shop takes no payment at booking.
 *  - Approval required: the barber decides first and payment comes later, so
 *    the row is an indefinite request, not a timed hold.
 *  - The shop's connected account cannot accept charges yet (onboarding
 *    unfinished) - this is the case where a shop has "deposit required" set in
 *    its settings and no deposit is ever actually taken.
 *  - Nothing to charge (unpriced service, or deposit mode with no amount set).
 */
/**
 * What, if anything, the public booking page collects before the appointment
 * becomes real: "payment" (ahead/deposit - a PaymentIntent), "card"
 * (card_on_file - a SetupIntent, nothing charged), or null (pay at the shop).
 *
 * Every gate `collectsPaymentUpFront` applies holds here too, for the same
 * reasons: no Connect, approval-first shops, an account that cannot take
 * charges yet. A saved card the shop could never charge is not protection, it
 * is a form the customer filled in for nothing.
 */
export function collectsAtBooking(input: {
  connectEnabled: boolean;
  paymentsMode: string | null;
  requireBookingApproval: boolean;
  connectChargesEnabled: boolean;
  stripeConnectAccountId: string | null;
  chargeCents: number | null;
}): "payment" | "card" | null {
  if (collectsPaymentUpFront(input)) return "payment";
  if (
    input.paymentsMode === "card_on_file" &&
    input.connectEnabled &&
    !input.requireBookingApproval &&
    input.connectChargesEnabled &&
    Boolean(input.stripeConnectAccountId)
  ) {
    return "card";
  }
  return null;
}

export function collectsPaymentUpFront(input: {
  connectEnabled: boolean;
  paymentsMode: string | null;
  requireBookingApproval: boolean;
  connectChargesEnabled: boolean;
  stripeConnectAccountId: string | null;
  chargeCents: number | null;
}): boolean {
  return (
    input.connectEnabled &&
    !input.requireBookingApproval &&
    (input.paymentsMode === "ahead" || input.paymentsMode === "deposit") &&
    input.connectChargesEnabled &&
    Boolean(input.stripeConnectAccountId) &&
    input.chargeCents !== null
  );
}

/**
 * What happened when we tried to turn a paid hold into a booking.
 *
 * Only `promoted` and `already_booked` mean the customer has an appointment.
 * `lapsed` and `slot_taken` mean we took money for a chair we cannot give
 * them, and the caller refunds.
 */
export type PromoteOutcome =
  | "promoted"
  | "already_booked"
  | "not_a_hold"
  | "lapsed"
  | "slot_taken"
  | "error";

/**
 * The payment succeeded: turn the hold into a real booking and send the
 * confirmations that were withheld at create time.
 *
 * Re-asserts the slot under the same advisory lock every other write path uses
 * rather than trusting the hold. That is not paranoia: between the hold
 * lapsing and the sweep flipping it to CANCELED there is a window where the
 * chair is genuinely free to everyone else (an expired hold stops blocking
 * immediately - the sweep is hygiene, not correctness), so a late payment
 * could otherwise be promoted straight over someone else's booking.
 *
 * Never throws. Safe to call twice - a second call on an already-promoted row
 * returns `already_booked` and sends nothing, because the notify helpers are
 * themselves at-most-once on their own stamps.
 */
export async function promotePaidHold(params: {
  appointmentId: string;
  now?: Date;
  /**
   * Send the withheld confirmations. Default true - the whole point of
   * promotion is that the customer can finally be told.
   *
   * The Acuity ambiguous-create path passes false: it settles the row as a
   * booking (so a hold with no PaymentIntent behind it cannot evaporate) while
   * its own rule is to promise the customer nothing until the reconciler has
   * confirmed the block by reference.
   */
  notify?: boolean;
}): Promise<PromoteOutcome> {
  const now = params.now ?? new Date();
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: params.appointmentId },
      select: {
        id: true,
        shopId: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        holdExpiresAt: true,
        holdReason: true,
        shop: { select: { bookingBufferMin: true, timezone: true } },
      },
    });
    if (!appt) return "error";

    // Already a booking. Either a webhook replay, or the shop never held in
    // the first place (Stripe was unreachable at create, so the booking was
    // promoted immediately and the customer pays in person). Nothing to do -
    // and NOT an error.
    if (appt.status === "BOOKED") return "already_booked";
    // A pending APPROVAL request is not ours to promote; the barber decides.
    if (appt.status !== "PENDING" || appt.holdReason !== "payment") {
      return appt.status === "CANCELED" ? "lapsed" : "not_a_hold";
    }

    // The hold ran out before the money arrived. Deliberately NOT promoted
    // even though the row is still PENDING: the chair has been free to
    // everyone else since the instant it lapsed.
    if (appt.holdExpiresAt !== null && appt.holdExpiresAt.getTime() <= now.getTime()) {
      logger.warn(
        { shopId: appt.shopId, appointmentId: appt.id },
        "payment hold: payment landed after the hold lapsed - refusing to promote",
      );
      return "lapsed";
    }

    // A targeted slot claimed by THIS appointment must not block its own
    // promotion (an active unbooked special blocks a normal booking).
    const targeted = await prisma.targetedSlot.findFirst({
      where: { shopId: appt.shopId, bookedAppointmentId: appt.id },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        staffId: appt.staffId,
        shopId: appt.shopId,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        bufferMin: appt.shop.bookingBufferMin,
        // Our own hold is the row being promoted - it cannot conflict with
        // itself, and it is excluded from the daily cap count for the same
        // reason.
        excludeAppointmentId: appt.id,
        serviceDayLimit: { serviceId: appt.serviceId, timezone: appt.shop.timezone },
        ...(targeted ? { targetedSlotIdToIgnore: targeted.id } : {}),
        // Customer-driven, exactly like the create that made this hold.
        walkInCapacity: "enforce",
        now,
      });

      // CAS on the hold itself. Belt and braces with the guard above: the
      // sweep may have flipped it to CANCELED between our read and here.
      const { count } = await tx.appointment.updateMany({
        where: { id: appt.id, status: "PENDING", holdReason: "payment" },
        data: { status: "BOOKED", holdExpiresAt: null, holdReason: null },
      });
      if (count === 0) throw new SlotTakenError();
    });

    logger.info(
      { shopId: appt.shopId, appointmentId: appt.id },
      "payment hold promoted to BOOKED",
    );

    // The confirmations that were deliberately withheld at booking time. Same
    // fire-and-forget shape as the public create: a send problem must not undo
    // a paid, durably-committed appointment.
    if (params.notify !== false) {
      void notifyAppointmentConfirmation({ shopId: appt.shopId, appointmentId: appt.id });
      void notifyBarberBookingEvent({
        shopId: appt.shopId,
        appointmentId: appt.id,
        kind: "booked",
      });
    }
    return "promoted";
  } catch (err) {
    if (err instanceof SlotTakenError || err instanceof ServiceDayFullError) {
      logger.warn(
        { appointmentId: params.appointmentId },
        "payment hold: slot was gone by the time payment landed",
      );
      return "slot_taken";
    }
    logger.error({ err, appointmentId: params.appointmentId }, "promotePaidHold failed");
    return "error";
  }
}

/**
 * We took the money but cannot give them the chair (the hold lapsed, or the
 * slot went while they were paying). Give it back in full and make sure the
 * appointment is dead.
 *
 * Full refund, no cancellation fee: the customer did nothing wrong, and a
 * shop's cancellation policy is about a booking they HAD, not one we failed to
 * give them.
 */
export async function refundUnhonoredHold(params: {
  appointmentId: string;
  shopId: string;
}): Promise<void> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { appointmentId: params.appointmentId },
      select: { id: true },
    });
    if (payment) await refundForCancellation({ paymentId: payment.id, feeCents: 0 });
    await releasePaymentHoldRow(params.shopId, params.appointmentId);
    logger.warn(
      { shopId: params.shopId, appointmentId: params.appointmentId },
      "payment hold: refunded a payment we could not honor",
    );
  } catch (err) {
    logger.error(
      { err, appointmentId: params.appointmentId },
      "refundUnhonoredHold FAILED - money may be held for an appointment that does not exist",
    );
  }
}

/**
 * Cancel the row and release anything holding real-world state for it. Used by
 * both the expiry sweep and the refund path above.
 *
 * Deliberately NOT cancelAppointment: there is no Visit to claw back, no
 * loyalty to reverse, and firing a "slot opened" blast for a chair nobody ever
 * really held would spam a waitlist for time that was never taken - the same
 * reasoning the receptionist hold sweep records.
 */
async function releasePaymentHoldRow(shopId: string, appointmentId: string): Promise<void> {
  await prisma.appointment.updateMany({
    where: { id: appointmentId, status: "PENDING", holdReason: "payment" },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  // Hand the chair back in Acuity. Unlike a receptionist hold, a payment hold
  // DOES take a block (see shouldMirrorOnCreate), so it has to give one back.
  await releaseForAppointment(shopId, appointmentId);
  // A card-on-file hold that lapsed may have a SetupIntent (or even a saved
  // card, if Stripe confirmed after the window). Detach it: the chair went back
  // on sale, and a card kept for an appointment that no longer exists is a
  // liability with no purpose. Dynamic import - cardOnFile.ts imports this file.
  const { releaseCardOnFile } = await import("../billing/cardOnFile.js");
  await releaseCardOnFile({ shopId, appointmentId, reason: "hold_lapsed" });
}

/**
 * Sweep payment holds whose window has closed.
 *
 * Heavier than the receptionist sweep on purpose, because a payment hold owns
 * two things a receptionist hold never does: an Acuity block and an in-flight
 * PaymentIntent. Dropping either would leave the barber's Acuity showing a
 * chair as busy forever, or the customer's card authorization dangling.
 *
 * Order is deliberate: cancel the row FIRST so the chair is unambiguously free
 * and a payment that lands a second later is refused by promotePaidHold (which
 * then refunds), rather than promoted into a slot someone else may have taken.
 */
export async function sweepExpiredPaymentHolds(now: Date = new Date()): Promise<number> {
  const expired = await prisma.appointment.findMany({
    where: { status: "PENDING", holdReason: "payment", holdExpiresAt: { lt: now } },
    select: { id: true, shopId: true },
    take: 200,
  });
  let swept = 0;
  for (const appt of expired) {
    try {
      await releasePaymentHoldRow(appt.shopId, appt.id);
      // Void the uncollected PaymentIntent so the customer is not left with a
      // pending charge for an appointment that no longer exists.
      // refundForCancellation already knows the difference between an
      // in-flight intent (cancel it) and collected money (refund it), so a
      // customer who paid in the last seconds of the window is made whole by
      // the same call.
      const payment = await prisma.payment.findUnique({
        where: { appointmentId: appt.id },
        select: { id: true },
      });
      if (payment) await refundForCancellation({ paymentId: payment.id, feeCents: 0 });
      swept++;
    } catch (err) {
      // One bad row must not stop the sweep; the next tick retries it.
      logger.error(
        { err, shopId: appt.shopId, appointmentId: appt.id },
        "payment hold sweep failed for one appointment",
      );
    }
  }
  if (swept > 0) logger.info({ count: swept }, "expired payment holds swept");
  return swept;
}
