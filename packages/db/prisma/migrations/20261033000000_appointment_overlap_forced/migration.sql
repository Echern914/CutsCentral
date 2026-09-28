/* BOOKED OVER A CONFLICT, ON PURPOSE.

   The dashboard's "Book anyway" lets an owner or manager put an appointment
   on time another booking, a synced visit or one of his own specials already
   holds - after the guard has named them and he has confirmed booking over
   exactly those. Until now nothing on the row said so: the forced booking
   looked like any other, and nobody could tell afterwards who had doubled the
   chair or when.

   Two nullable columns. Additive only: no existing row changes value, and
   every row written before this - and every normal booking after it - carries
   NULL in both. */

ALTER TABLE "Appointment" ADD COLUMN "overlapForcedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "overlapForcedByUserId" TEXT;

/* A "who" without a "when" is not a record of anything. */
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_overlap_forced_by_needs_at_check"
  CHECK ("overlapForcedByUserId" IS NULL OR "overlapForcedAt" IS NOT NULL);
