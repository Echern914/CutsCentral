/* WHAT A CLIENT MAY CHANGE THEMSELVES, AND UNTIL WHEN.

   A client could always cancel online (the manage link, the group link, a
   text to the receptionist) right up to the start, and could always move a
   booking outside the reschedule cutoff (#637). Each shop now decides:

   1. "customerCanReschedule": NOT NULL, DEFAULT true - clients may move a
      booking themselves (today's behavior). Off = they're told to contact
      the shop.
   2. "customerCanCancel": NOT NULL, DEFAULT true - the same for cancelling.
   3. "cancelCutoffHours": NOT NULL, DEFAULT 0 - how close to the start a
      client may still cancel themselves; 0 = until it starts (today's
      behavior). A CHECK pins it to whole hours from 0 to a week, the range
      the settings API accepts (config/customerChangeRules.ts).

   The barber changes anything from the dashboard regardless. The FEE for a
   late cancel is the Payments setting (cancelWindowHours / cancelFeeBps),
   untouched here.

   Additive. Every default keeps today's behavior. ADD COLUMN with a constant
   default is a catalog-only change in Postgres 11+, so no row is rewritten
   and no row trigger fires; the existing table grants and tenant policy cover
   the new columns. Reversible by dropping the constraint and the columns. */

ALTER TABLE "Shop" ADD COLUMN "customerCanReschedule" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "customerCanCancel" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "cancelCutoffHours" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_cancelCutoffHours_range"
  CHECK ("cancelCutoffHours" BETWEEN 0 AND 168);
