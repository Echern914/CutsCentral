-- #464: the payments reconciler's memory of which contradiction it has
-- already raised for a row, so a contradiction left for a person is raised
-- ONCE, not on every 15-minute pass. Written only by billing/reconcile.ts,
-- with raw SQL so Payment.updatedAt does not move. Not money, not status.
--
--   reconcileEscalation        which recurring contradiction was raised
--   reconcileEscalatedVersion  the row's updatedAt when it was raised; any
--                              later write to the row raises it again
--
-- No backfill: every row in a contradiction today is raised once more, then
-- remembered.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reconcileEscalation" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reconcileEscalatedVersion" TIMESTAMP(3);
