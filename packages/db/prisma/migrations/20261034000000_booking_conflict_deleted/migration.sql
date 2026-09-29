-- Delete a RESOLVED conflict from the manager's inbox (a barber: "all resolved
-- appointments should be able to be deleted").
--
-- A SOFT DELETE. The row stays: it is the audit trail of a chair that was
-- double-booked, and its unique key is what stops the same collision being
-- recorded and alerted twice. The inbox simply stops listing it.
--
-- The prefix is a SEQUENCE NUMBER, not a date (see CLAUDE.md):
-- 20261033000000 is the last one on main.
--
-- EXPAND ONLY. Two nullable columns and a CHECK that every existing row
-- already satisfies (both columns are NULL). A running old API neither reads
-- nor writes them. The table already grants UPDATE to chairback_app, under
-- its tenant policy.
ALTER TABLE "BookingConflict" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "BookingConflict" ADD COLUMN IF NOT EXISTS "deletedByUserId" TEXT;

-- Only a conflict somebody has dealt with can leave the list. The route
-- refuses an open one; this refuses it again for any writer the route is not.
ALTER TABLE "BookingConflict" DROP CONSTRAINT IF EXISTS "BookingConflict_delete_only_resolved";
ALTER TABLE "BookingConflict" ADD CONSTRAINT "BookingConflict_delete_only_resolved"
  CHECK ("deletedAt" IS NULL OR "resolvedAt" IS NOT NULL);
