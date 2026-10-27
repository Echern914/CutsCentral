/* MINIMUM NOTICE IN MINUTES.

   A barber typed 15 into "Min notice (hours)" meaning fifteen MINUTES; it was
   saved as fifteen hours and turned away a same-day client. Fifteen minutes
   could not be stored at all: the only column was whole hours.

   1. "bookingLeadMinutes": NOT NULL, DEFAULT 120 (the old 2-hour default), the
      column every reader now uses.
   2. Backfill from the hours column, so no shop's notice changes by a minute.
   3. A CHECK pins it to 0..30 days, the range the settings API accepts
      (43200 = the old 720-hour ceiling).

   "bookingLeadHours" STAYS, on purpose. Railway migrates before the new API
   starts, so for a moment the OLD code (which reads hours) runs against this
   schema; and a column read before its migration once took every sign-in
   down. The API keeps writing hours = ceil(minutes / 60) alongside, so the
   legacy column never lies. It can be dropped in a later migration once no
   deployed code reads it.

   Additive. ADD COLUMN with a constant default is catalog-only; the backfill
   touches each shop row once and Shop has no row triggers. Reversible by
   dropping the constraint and the column (hours were never changed). */

ALTER TABLE "Shop" ADD COLUMN "bookingLeadMinutes" INTEGER NOT NULL DEFAULT 120;

UPDATE "Shop" SET "bookingLeadMinutes" = "bookingLeadHours" * 60;

ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_bookingLeadMinutes_range"
  CHECK ("bookingLeadMinutes" BETWEEN 0 AND 43200);
