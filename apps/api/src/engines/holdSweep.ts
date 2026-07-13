import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Expired AI-receptionist holds -> CANCELED, as a LIGHT updateMany flip
 * (deliberately NOT cancelAppointment): a hold has no payment to refund, no
 * Visit to claw back, and firing a slot-opened blast for a slot no one really
 * held would be wrong - the exact reasoning behind the decline path in
 * booking.dashboard.ts. Structurally incapable of the offer->hold->expire->
 * "slot opened"->offer loop because nothing here calls notifySlotOpened.
 *
 * PURE HYGIENE, not correctness: the slot engine and every overlap guard
 * already exclude expired holds (holdExpiresAt <= now), so the slot released
 * the instant the hold lapsed. This sweep just keeps the rows tidy.
 */
export async function sweepExpiredHolds(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.appointment.updateMany({
    where: { status: "PENDING", holdExpiresAt: { lt: now } },
    data: { status: "CANCELED", canceledAt: now },
  });
  if (count > 0) logger.info({ count }, "expired receptionist holds swept");
  return count;
}
