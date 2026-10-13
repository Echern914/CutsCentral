/* A CLIENT CAN NO LONGER MOVE A CUT AN HOUR BEFORE IT.

   A client could move a booking from the manage link (or by texting the
   receptionist) right up to its start, leaving the barber an empty chair
   nobody else could book in time. Each shop now has a cutoff: inside it the
   client is told to contact the shop. Cancelling is unchanged.

   1. "rescheduleCutoffHours": NOT NULL, DEFAULT 24, so every existing shop
      gets a day's notice and the barber can change it (0 = no cutoff) in
      Booking settings.
   2. A CHECK pins it to whole hours from 0 to a week, the same range the
      settings API accepts (config/rescheduleCutoff.ts).

   Additive. ADD COLUMN with a constant default is a catalog-only change in
   Postgres 11+, so no row is rewritten and no row trigger fires; the existing
   table grants and tenant policy cover the new column. Reversible by dropping
   the constraint and the column. */

ALTER TABLE "Shop" ADD COLUMN "rescheduleCutoffHours" INTEGER NOT NULL DEFAULT 24;

ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_rescheduleCutoffHours_range"
  CHECK ("rescheduleCutoffHours" BETWEEN 0 AND 168);
