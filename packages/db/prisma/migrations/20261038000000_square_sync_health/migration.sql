-- Square sync health: when the whole book last came in, when a sync last
-- succeeded, and why the last one failed.
--
-- WHY. Square's ListBookings refuses a start-time range longer than 31 days,
-- and every request ChairBack made was longer, so every connect-time import
-- and every half-hourly sweep failed with a 400 - while the connect card said
-- "Connected". The fix walks in 30-day slices; these columns make the next
-- failure visible instead of silent.
--
-- backfilledAt starts NULL for every existing connection ON PURPOSE: the
-- sweep imports the whole book for any connection that has never had one, so
-- the shops whose history never arrived receive it on the first sweep after
-- this deploys, with no one having to press anything. The import is
-- idempotent (Visit is unique on the square:{bookingId} key) and imported
-- history sends customers nothing (engines/syncedVisitTrust.ts, rule 2).
--
-- Additive and nullable: no default to compute, no rewrite of existing rows.
ALTER TABLE "SquareConnection" ADD COLUMN "backfilledAt" TIMESTAMP(3);
ALTER TABLE "SquareConnection" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "SquareConnection" ADD COLUMN "lastSyncError" TEXT;
