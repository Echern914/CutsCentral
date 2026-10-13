import { prisma } from "@chairback/db";
import { COMPLETED_VISIT_CORRECTION_DAYS } from "@chairback/config";
import { lockStaffAndAssertSlotFree } from "./bookingWrite.js";
import { recordMirrorIntent } from "./acuityMirror.js";
import { appointmentOwnedByPlatform } from "./visitOrigin.js";
import { isRecordedWalkIn } from "./walkInReceipt.js";
import { CORRECTION_WINDOW_MS } from "./visitCorrection.js";

/**
 * MARKING A NO-SHOW, AND TAKING ONE BACK.
 *
 * A shop owner marked an appointment a no-show by mistake - a FUTURE one, a
 * day early - and nothing could put it back. Two rules live here, read by the
 * routes and by the appointment detail so the sheet's offer and the server's
 * answer can never disagree:
 *
 * 1. NO NO-SHOW BEFORE THE START. A client can only fail to show up once the
 *    time has come. Marking a future booking a no-show was a misclick with
 *    real consequences: a card kept on file was charged the no-show fee at
 *    once, for an appointment that had not happened. Before the start, the
 *    honest action is Cancel.
 *
 * 2. UNDO NO-SHOW puts the booking back to BOOKED - the status it was in -
 *    and nothing else. It never moves money: a no-show fee already charged
 *    stays charged, a deposit stays where it is, a refund the shop gave stays
 *    given. The answer lists each of those in words, so the shop knows what
 *    (if anything) still needs its own action. Everything else follows from
 *    BOOKED through the paths that already exist:
 *      - the chair is re-checked under the one overlap guard
 *        (lockStaffAndAssertSlotFree): if someone has since taken the time,
 *        the undo is refused and says so, never a silent double-booking;
 *      - the Acuity block is placed again through the outbox, exactly like a
 *        restored cancel;
 *      - reminders not yet sent go out as normal (every sweep reads BOOKED);
 *        ones already sent are not sent again (their stamps are untouched);
 *      - a booking whose time has passed is completed by the 15-minute sweep
 *        like any finished booking, which earns its punch then - once.
 *    A no-show of a future booking had no Visit, so it took back no punch,
 *    and none is given here.
 *
 * NOT UNDONE HERE (refused with a reason): a booking another app owns, a
 * walk-in, a visit that was COMPLETED before it was corrected to a no-show
 * (its punch was taken back - log the visit again), one older than the
 * correction window, and one whose no-show charge is still being confirmed.
 */

export type UndoNoShowRefusal =
  | "not_no_show"
  | "external"
  | "walk_in"
  | "was_completed"
  | "too_old"
  | "fee_pending";

export interface UndoNoShowFacts {
  status: string;
  endsAt: Date;
  completedAt: Date | null;
  visitId: string | null;
  firstName: string;
  bookedVia: string | null;
  seriesId: string | null;
  groupId: string | null;
  service: { name: string } | null;
  visit: { acuityAppointmentId: string } | null;
  cardOnFile: { status: string } | null;
}

/** The fields UndoNoShowFacts needs, as a Prisma `select`. */
export const UNDO_NO_SHOW_SELECT = {
  status: true,
  endsAt: true,
  completedAt: true,
  visitId: true,
  firstName: true,
  bookedVia: true,
  seriesId: true,
  groupId: true,
  service: { select: { name: true } },
  visit: { select: { acuityAppointmentId: true } },
  cardOnFile: { select: { status: true } },
} as const;

/** Why this no-show cannot be undone, or null when it can. Pure. */
export function undoNoShowRefusal(appt: UndoNoShowFacts, now: Date): UndoNoShowRefusal | null {
  if (appt.status !== "NO_SHOW") return "not_no_show";
  if (appointmentOwnedByPlatform(appt)) return "external";
  if (isRecordedWalkIn(appt) || appt.bookedVia === "walk_in_queue") return "walk_in";
  if (appt.completedAt !== null || appt.visitId !== null) return "was_completed";
  if (now.getTime() - appt.endsAt.getTime() > CORRECTION_WINDOW_MS) return "too_old";
  if (appt.cardOnFile?.status === "charging") return "fee_pending";
  return null;
}

/** The sentence the shop reads for each refusal (the sheet shows it as-is). */
export function undoNoShowRefusalMessage(reason: UndoNoShowRefusal | "slot_taken"): string {
  switch (reason) {
    case "not_no_show":
      return "This appointment isn't marked a no-show any more.";
    case "external":
      return "This booking is managed in another app. Change it there.";
    case "walk_in":
      return "This is a walk-in, so there is no booking to put back.";
    case "was_completed":
      return "This visit was completed before it was marked a no-show, and its punch was taken back. Log the visit again instead.";
    case "too_old":
      return `This appointment was more than ${COMPLETED_VISIT_CORRECTION_DAYS} days ago, so it can't be changed now.`;
    case "fee_pending":
      return "A no-show charge to the client's card is still being confirmed. Try again in a few minutes.";
    case "slot_taken":
      return "Another booking now holds this time, so it can't go back on the calendar as it was. Book the client again at a free time instead.";
  }
}

/** Whether a booking's no-show may be marked yet: only once its start has come. */
export function noShowTooEarly(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() > now.getTime();
}

export const NO_SHOW_TOO_EARLY_MESSAGE =
  "This appointment hasn't started yet, so it can't be a no-show. Cancel it instead, or mark the no-show once its start time has passed.";

/** A refusal raised inside the undo transaction (the CAS lost, or the chair is taken). */
export class UndoNoShowRefusedError extends Error {
  constructor(readonly reason: UndoNoShowRefusal) {
    super(`undo no-show refused: ${reason}`);
  }
}

/** Format integer cents as "$12" or "$12.50". */
function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * What stays as it is after an undo, in words. Read AFTER the undo commits, so
 * it describes the booking as it now stands. Never an instruction to us to
 * move money - each line is something the shop may choose to do itself.
 */
export async function undoNoShowNotes(
  shopId: string,
  appointmentId: string,
  now: Date,
): Promise<string[]> {
  const [appt, payments, card] = await Promise.all([
    prisma.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: { endsAt: true },
    }),
    prisma.payment.findMany({
      where: { appointmentId, shopId, purpose: { in: ["fee", "booking"] } },
      select: { purpose: true, status: true, amount: true, capturedAmount: true, refundedAmount: true },
    }),
    prisma.cardOnFile.findUnique({
      where: { appointmentId },
      select: { status: true, last4: true },
    }),
  ]);
  const notes: string[] = [];
  const cardName = card?.last4 ? `the card ending ${card.last4}` : "the client's card";
  const fee = payments.find(
    (p) => p.purpose === "fee" && (p.status === "succeeded" || p.status === "partially_refunded"),
  );
  if (fee) {
    const kept = (fee.capturedAmount ?? fee.amount) - (fee.refundedAmount ?? 0);
    if (kept > 0) {
      notes.push(
        `The ${money(kept)} no-show fee charged to ${cardName} was not refunded. If it shouldn't stand, refund it in your Stripe dashboard.`,
      );
    }
  } else if (card && (card.status === "charged" || card.status === "released")) {
    notes.push(
      `The card saved for this booking was released when it was marked a no-show, so it won't cover a fee if they miss this one.`,
    );
  }
  const refundedDeposit = payments.find(
    (p) => p.purpose === "booking" && (p.refundedAmount ?? 0) > 0,
  );
  if (refundedDeposit) {
    notes.push("The deposit you refunded stays refunded.");
  }
  if (appt && appt.endsAt.getTime() <= now.getTime()) {
    notes.push("Its time has passed, so it will be marked done shortly, like any finished appointment.");
  }
  return notes;
}

/**
 * Put a no-show back to BOOKED, in one transaction: the refusal rule re-read
 * inside it, the chair re-checked under the shared lock, the status moved by
 * compare-and-set (a second tap finds BOOKED and changes nothing), the Acuity
 * block re-recorded, and who did it appended to AppointmentStatusChange.
 * Returns the outbox ids to dispatch after commit.
 */
export async function undoNoShow(input: {
  shopId: string;
  appointmentId: string;
  actorUserId: string | null;
  bufferMin: number;
  now: Date;
}): Promise<{ mirrorOutboxIds: string[] }> {
  const { shopId, appointmentId, actorUserId, now } = input;
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: { id: true, staffId: true, startsAt: true, ...UNDO_NO_SHOW_SELECT },
    });
    if (!appt) throw new UndoNoShowRefusedError("not_no_show");
    const refusal = undoNoShowRefusal(appt, now);
    if (refusal) throw new UndoNoShowRefusedError(refusal);

    // A booked special stays claimed by a no-show (cancelAppointment releases
    // it on a cancel only), so it is this booking's own and must not veto it.
    const special = await tx.targetedSlot.findFirst({
      where: { shopId, bookedAppointmentId: appt.id },
      select: { id: true },
    });
    await lockStaffAndAssertSlotFree(tx, {
      // No override step here: a block made since is the shop's own choice.
      externalBlocks: "enforce",
      walkInCapacity: "ignore",
      staffId: appt.staffId,
      shopId,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      bufferMin: input.bufferMin,
      excludeAppointmentId: appt.id,
      // Staff-driven, like restore and the dashboard reschedule.
      serviceDayLimit: null,
      overrideWaitlistHolds: true,
      targetedSlotIdToIgnore: special?.id,
    });
    const moved = await tx.appointment.updateMany({
      where: { id: appt.id, shopId, status: "NO_SHOW" },
      // Un-hide it too: a restored booking the barber can't see is lost.
      data: { status: "BOOKED", dismissedAt: null },
    });
    if (moved.count === 0) throw new UndoNoShowRefusedError("not_no_show");
    await tx.appointmentStatusChange.create({
      data: {
        shopId,
        appointmentId: appt.id,
        actorUserId,
        kind: "undo_no_show",
        fromStatus: "NO_SHOW",
        toStatus: "BOOKED",
      },
    });
    const mirrorOutboxIds = await recordMirrorIntent(tx, {
      shopId,
      now,
      appointmentId: appt.id,
      staffId: appt.staffId,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      occupancy: {
        status: "BOOKED",
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        holdExpiresAt: null,
        visitId: null,
      },
    });
    return { mirrorOutboxIds };
  });
}

/** Append the "who marked it a no-show" row. Called right after the mark commits. */
export async function recordNoShowMarked(input: {
  shopId: string;
  appointmentId: string;
  actorUserId: string | null;
}): Promise<void> {
  await prisma.appointmentStatusChange.create({
    data: {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      actorUserId: input.actorUserId,
      kind: "no_show",
      fromStatus: "BOOKED",
      toStatus: "NO_SHOW",
    },
  });
}

