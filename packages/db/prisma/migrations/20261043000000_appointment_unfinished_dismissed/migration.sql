-- The barber takes an unfinished checkout off the "Didn't finish booking" list
-- (Appointment.unfinishedDismissedAt).
--
-- Presentation only: the row is never deleted or changed in any other way. It
-- is a separate column from "dismissedAt", which clears a cancelled booking off
-- the day view and is undone by a restore.
--
-- Nullable with no default, so this is a metadata-only change on an existing
-- table, and every existing row reads as "not dismissed", which is correct.
ALTER TABLE "Appointment" ADD COLUMN "unfinishedDismissedAt" TIMESTAMP(3);

-- No index. The list reads a shop's future payment holds by ("shopId",
-- "status", "startsAt"); this is a residual filter on a handful of rows.
