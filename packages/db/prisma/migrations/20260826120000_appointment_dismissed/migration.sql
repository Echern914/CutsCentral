-- The barber clears a cancelled booking off the day view.
--
-- Presentation only, and deliberately NOT a delete: cancellation history,
-- loyalty clawbacks and reporting all depend on the row continuing to exist.
-- This just stops it taking up space on a schedule it no longer belongs to.
--
-- Nullable with no default, so the migration is a pure metadata change on an
-- existing table (no rewrite, no lock held while every row is touched) and
-- every existing appointment reads as "not dismissed", which is correct.
ALTER TABLE "Appointment" ADD COLUMN "dismissedAt" TIMESTAMP(3);

-- No index. The agenda already reads by ("shopId", "startsAt"); `dismissedAt IS
-- NULL` is a cheap residual filter on a window that is at most ~59 days, and an
-- index on a column that is NULL for almost every row would earn nothing.
