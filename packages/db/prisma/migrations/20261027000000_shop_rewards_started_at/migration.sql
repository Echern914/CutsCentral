-- When a shop's rewards started (issue #516). A visit that ended before it no
-- longer earns a punch by itself: the half-hourly resync re-reads a year of
-- visits, and every completed one used to earn the moment rewards came on.
-- Past visits now earn only when the owner credits them from the Rewards page.
--
-- The switch stamps it on every off->on. For shops that exist today:
--
--   rewards ON   the date of the earliest punch in their ledger that was
--                earned from a visit - when they really began earning. A
--                shop with no such punch yet starts now (UTC: the column
--                holds UTC whatever this session's TimeZone is).
--   rewards OFF  NULL, until the next switch-on stamps it.
--
-- Additive: one nullable column and one UPDATE of it. The ledger is only read,
-- never written, so every balance stays exactly as it is.
ALTER TABLE "Shop" ADD COLUMN "rewardsStartedAt" TIMESTAMP(3);

UPDATE "Shop" s
   SET "rewardsStartedAt" = COALESCE(
         (SELECT MIN(p."createdAt")
            FROM "PunchLedger" p
           WHERE p."shopId" = s."id"
             AND p."punchesEarned" > 0
             AND p."reversalOfId" IS NULL
             -- A visit earn: still linked to its visit, or detached from it
             -- later (a claw-back or a deleted visit) but still noted "visit".
             AND (p."visitId" IS NOT NULL OR p."note" = 'visit')),
         now() AT TIME ZONE 'UTC')
 WHERE s."rewardsEnabled" = true;
