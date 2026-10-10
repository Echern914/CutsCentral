import { COMPLETED_VISIT_CORRECTION_DAYS } from "@chairback/config";
import { prisma } from "@chairback/db";
import { cardIsKept, DEAD_PAYMENT_STATUSES, KEPT_BY_A_NO_SHOW } from "./appointmentPromotion.js";
import { appointmentOwnedByPlatform } from "./visitOrigin.js";
import { isRecordedWalkIn } from "./walkInReceipt.js";

/**
 * MARKING A COMPLETED VISIT A NO-SHOW (OR CANCELLED) AFTER THE FACT.
 *
 * A shop owner: an 8:00 booking whose client never came "shows Completed and I
 * can't remove him from my schedule". The 15-minute sweep
 * (promoteFulfilledAppointments) turns every BOOKED visit whose end has passed
 * into a COMPLETED one with a punch, and from then on neither No-show nor
 * Cancel was offered. This is the one rule for which completed visits may be
 * put right - read by POST /appointments/:id/correct-completed and by the
 * appointment detail (`correctable`), so the sheet's offer and the server's
 * answer cannot disagree.
 *
 * ELIGIBLE: a ChairBack booking (not synced from Acuity or Square, not a
 * walk-in - a recorded walk-in has Remove walk-in, a queue walk-in was in the
 * chair), COMPLETED, which ended no more than COMPLETED_VISIT_CORRECTION_DAYS
 * ago, with NO MONEY on it: no Payment of any purpose that is not dead (a
 * deposit, a card checkout, a tip), no kept card, and not checked out at the
 * chair. A visit with money on it happened, or has money only the shop's own
 * refund should touch.
 *
 * ONE EXCEPTION, NO-SHOW ONLY: a collected BOOKING payment (the deposit or
 * pay-ahead) does not stop a no-show correction. An ordinary no-show keeps it
 * too; it stays exactly as it is, and the shop's own Refund deposit can give it
 * back afterwards. A CANCEL is still refused over it - an ordinary cancel would
 * refund it, and this path never moves money.
 *
 * Whether the SHOP finished it (Done / checkout: `completedByShop`) or the
 * sweep did is deliberately NOT a condition: a Done pressed on the wrong row is
 * the same mistake, and a checked-out visit is already refused above.
 */
export type CorrectionRefusal =
  | "not_completed"
  | "external"
  | "walk_in"
  | "too_old"
  | "checked_out"
  | "money_taken"
  | "deposit_paid";

export const CORRECTION_WINDOW_MS = COMPLETED_VISIT_CORRECTION_DAYS * 24 * 60 * 60 * 1000;

export interface CorrectionFacts {
  status: string;
  endsAt: Date;
  paidAt: Date | null;
  paidAmount: unknown;
  firstName: string;
  bookedVia: string | null;
  seriesId: string | null;
  groupId: string | null;
  service: { name: string } | null;
  visit: { acuityAppointmentId: string } | null;
  cardOnFile: { status: string } | null;
}

/** The fields CorrectionFacts needs, as a Prisma `select`. */
export const CORRECTION_SELECT = {
  status: true,
  endsAt: true,
  paidAt: true,
  paidAmount: true,
  firstName: true,
  bookedVia: true,
  seriesId: true,
  groupId: true,
  service: { select: { name: true } },
  visit: { select: { acuityAppointmentId: true } },
  cardOnFile: { select: { status: true } },
} as const;

/** The money on a visit, split the way the correction rule needs it. */
export interface CorrectionMoney {
  /** A collected booking payment (deposit / pay-ahead): a no-show keeps it. */
  bookingPaid: boolean;
  /** Any OTHER live payment: a tip, a checkout, a payable form, a refund... */
  other: boolean;
}

/**
 * Why this visit cannot be corrected to `outcome`, or null when it can. Pure.
 * The sheet's `correctable` asks it for NO_SHOW.
 */
export function correctionRefusal(
  appt: CorrectionFacts,
  money: CorrectionMoney,
  now: Date,
  outcome: "NO_SHOW" | "CANCELED",
): CorrectionRefusal | null {
  if (appt.status !== "COMPLETED") return "not_completed";
  if (appointmentOwnedByPlatform(appt)) return "external";
  if (isRecordedWalkIn(appt) || appt.bookedVia === "walk_in_queue") return "walk_in";
  if (now.getTime() - appt.endsAt.getTime() > CORRECTION_WINDOW_MS) return "too_old";
  if (appt.paidAt !== null || appt.paidAmount != null) return "checked_out";
  if (money.other || cardIsKept(appt.cardOnFile)) return "money_taken";
  if (money.bookingPaid && outcome !== "NO_SHOW") return "deposit_paid";
  return null;
}

/**
 * The Payments on this booking that are money - the SAME tests the cancel
 * engine's refuseIfMoney / keepBookingPayment guard runs in its transaction.
 */
export async function correctionMoney(
  shopId: string,
  appointmentId: string,
): Promise<CorrectionMoney> {
  const live = await prisma.payment.findMany({
    where: { appointmentId, shopId, status: { notIn: [...DEAD_PAYMENT_STATUSES] } },
    select: { purpose: true, status: true },
  });
  const kept = (p: { purpose: string; status: string }) =>
    p.purpose === KEPT_BY_A_NO_SHOW.purpose && p.status === KEPT_BY_A_NO_SHOW.status;
  return { bookingPaid: live.some(kept), other: live.some((p) => !kept(p)) };
}

/** The sentence the shop reads for each refusal (the sheet shows it as-is). */
export function correctionRefusalMessage(reason: CorrectionRefusal): string {
  switch (reason) {
    case "checked_out":
      return "This visit was checked out, so a payment is recorded for it. It can't be marked a no-show or canceled.";
    case "money_taken":
      return "This visit has money on it through ChairBack (a deposit, card payment, tip or saved card), so it can't be changed here. If that money should go back, refund it first.";
    case "deposit_paid":
      return "This visit has a deposit paid through ChairBack, and canceling it here would not refund it. If the client didn't come, use Mark no-show instead: the deposit stays as it is, and you can refund it from the visit afterwards if you choose.";
    case "too_old":
      return `This visit ended more than ${COMPLETED_VISIT_CORRECTION_DAYS} days ago, so it can't be changed now.`;
    case "walk_in":
      return "This is a walk-in. Use Remove walk-in instead.";
    case "external":
      return "This booking is managed in another app. Change it there.";
    case "not_completed":
      return "Only a completed visit can be changed this way.";
  }
}
