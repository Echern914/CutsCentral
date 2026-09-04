import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { noteAvailabilityChangedFor } from "../services/availabilityCache.js";

/**
 * Expired AI-receptionist holds -> CANCELED, as a LIGHT updateMany flip
 * (deliberately NOT cancelAppointment): a hold has no payment to refund, no
 * Visit to claw back, and firing a slot-opened blast for a slot no one really
 * held would be wrong - the exact reasoning behind the decline path in
 * booking.dashboard.ts. Structurally incapable of the offer->hold->expire->
 * "slot opened"->offer loop because nothing here calls notifySlotOpened.
 *
 * MOSTLY hygiene: the slot engine and every overlap guard already exclude
 * expired holds (holdExpiresAt <= now), so the slot released the instant the
 * hold lapsed. But an unswept expired hold still occupies the partial-unique
 * (staffId, startsAt) key (widened to PENDING rows by the approval migration)
 * - lockStaffAndAssertSlotFree clears the exact-start ghost inline for every
 * write path; this sweep tidies the rest.
 *
 * 🔴 SCOPED TO RECEPTIONIST HOLDS (holdReason IS NULL). A PAYMENT hold looks
 * identical in the schema but owns two things this light flip does not know
 * about - an Acuity block and an in-flight PaymentIntent - so cancelling one
 * here would strand a block on the barber's calendar forever and leave the
 * customer's card authorization dangling. Those are swept by
 * sweepExpiredPaymentHolds in services/appointmentPaymentHold.ts.
 */
export async function sweepExpiredHolds(now: Date = new Date()): Promise<number> {
  // RETURNING the shop of every row flipped, so the availability generation is
  // advanced for exactly the shops whose time this freed - per shop, never a
  // global clear. ISO text + ::timestamp, never a raw Date (PR #70).
  const rows = await prisma.$queryRaw<{ shopId: string }[]>`
    UPDATE "Appointment"
       SET "status" = 'CANCELED', "canceledAt" = ${now.toISOString()}::timestamp
     WHERE "status" = 'PENDING'
       AND "holdReason" IS NULL
       AND "holdExpiresAt" < ${now.toISOString()}::timestamp
     RETURNING "shopId"`;
  const count = rows.length;
  if (count > 0) {
    logger.info({ count }, "expired receptionist holds swept");
    // The slot engine already ignores an expired hold, so the chair was free
    // the instant it lapsed - this is about the cached page catching up.
    await noteAvailabilityChangedFor(rows.map((r) => r.shopId));
  }
  return count;
}
