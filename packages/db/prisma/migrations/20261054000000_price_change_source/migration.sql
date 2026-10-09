-- The price ledger records a reschedule's accepted menu reprice (#620). Mark
-- those rows, so a later move does not read them as a hand edit and keep a
-- figure that was only ever the menu's price for the OLD time.
-- Additive and nullable: every existing row is a change by hand (NULL).
-- ADD COLUMN fires no row trigger, so the append-only trigger is untouched;
-- the table-level grants and the tenant policy cover the new column.

ALTER TABLE "AppointmentPriceChange" ADD COLUMN "source" TEXT;

ALTER TABLE "AppointmentPriceChange"
  ADD CONSTRAINT "AppointmentPriceChange_source_check"
  CHECK ("source" IS NULL OR "source" = 'move');
