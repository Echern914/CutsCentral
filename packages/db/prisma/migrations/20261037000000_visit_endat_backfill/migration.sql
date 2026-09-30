-- Give every Visit with no end time the one the ingest has used since
-- 2026-08-05: its start plus 30 minutes.
--
-- WHY. The status-promotion job completes a synced visit once `endAt < now`,
-- and Prisma's `lt` never matches NULL - so a visit stored without an end time
-- is never completed. Before the ingest learned to fall back (4d0e9464), one
-- live shop's Acuity history import stored 19,920 past visits (Oct 2022 - Jul
-- 2026) with a NULL end: four years of history that never completed, so those
-- clients had no last visit, no rhythm and no tier (2,315 of 2,316 tierless).
-- A resync does not repair them: the half-hourly walk covers a recent window,
-- and most of these are older than it.
--
-- WHAT HAPPENS NEXT. The promotion job completes them in bounded batches,
-- newest first (engines/statusPromotion.ts). Nothing is announced: a
-- completion is only announced within a day of the visit ending
-- (engines/syncedVisitTrust.ts). A punch is earned only for a visit that ended
-- after the shop's rewards started (services/punch.ts), silently.
--
-- The prefix is a SEQUENCE NUMBER, not a date (see CLAUDE.md): 20261036000000
-- is the last one on main.
--
-- DATA ONLY, idempotent: a second run matches no rows. 30 minutes is the same
-- default the ingest and utilization already assume for a missing end.
UPDATE "Visit"
   SET "endAt" = "scheduledAt" + interval '30 minutes'
 WHERE "endAt" IS NULL;
