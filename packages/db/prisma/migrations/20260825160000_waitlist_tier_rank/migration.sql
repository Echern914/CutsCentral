-- Waitlist: rank the offer queue by loyalty tier.
--
-- The scan orders by (tierRank, createdAt, id) from here on. Gold first, then
-- Silver, then everyone else; inside a rank nothing changes - earliest joiner
-- first, one offer at a time, expiry still advancing to the next eligible
-- entry exactly as it does today.
--
-- 🔴 THE RANK IS A SNAPSHOT, TAKEN AT ENQUEUE, and is never recomputed while
-- an entry waits (engines/waitlistTierRank.ts states the reasoning). Which is
-- why THIS MIGRATION DELIBERATELY DOES NOT BACKFILL ANYTHING. An entry that
-- joined last week joined without a tier, because there were no tiers in this
-- queue last week; stamping it with its client's tier TODAY would be exactly
-- the retroactive reordering the snapshot rule exists to prevent, and would
-- reshuffle a live queue the moment this deploys.
--
-- So every existing row ranks at the no-standing default, all ranks are equal,
-- and (tierRank, createdAt, id) degenerates to the (createdAt, id) the
-- waitlist has always used. THIS CHANGE ARRIVES INERT and takes effect as new
-- joins carry tiers - which also means it is safe to ship before
-- WaitlistEntry.clientId coverage is good (see
-- `pnpm --filter @chairback/db report:waitlist-links`).
--
-- If a one-time reshuffle of the existing queue is ever wanted, it is a
-- separate, deliberate statement in its own migration - not a side effect of
-- adding the column.

/* ---------------------------------------------------------------- */
/* 1. The column                                                      */
/* ---------------------------------------------------------------- */

-- NOT NULL with a constant default: since PG11 that is a catalogue-only
-- change, so no table rewrite and no long lock even on a large waitlist.
--
-- 30 is RANK_NONE in engines/waitlistTierRank.ts, which is also Bronze's rank
-- - an entry with no linked client and a Bronze member interleave purely by
-- join time, exactly as they do now. The two constants must agree; a test
-- creates a row without the column and asserts what comes back.
--
-- 🔴 NOT NULL is load-bearing, not tidiness. The scan resumes by keyset and
-- `column > NULL` is NULL rather than true, so a single nullable ranking
-- column makes the cursor stop visiting the tail of the queue - silently,
-- with no error, forever.
ALTER TABLE "WaitlistEntry"
  ADD COLUMN "tierRank" INTEGER NOT NULL DEFAULT 30;

/* ---------------------------------------------------------------- */
/* 2. The index the scan actually needs                               */
/* ---------------------------------------------------------------- */

-- Prepending the rank made "WaitlistEntry_shopId_status_createdAt_idx"
-- useless for the ordering: it can still satisfy the WHERE, but every page
-- would then sort the shop's whole waiting list to find fifty rows. This one
-- matches the scan exactly - equality on (shopId, status), then the full sort
-- key - so a page is an index range read in order.
--
-- Plain (non-CONCURRENT) build, for the reason already written down in
-- 20260824210000_waitlist_entry_expiry: these tables are small, so the build
-- locks only momentarily, and CREATE INDEX CONCURRENTLY cannot run inside the
-- transaction Prisma wraps a migration in.
CREATE INDEX IF NOT EXISTS "WaitlistEntry_shopId_status_tierRank_createdAt_id_idx"
  ON "WaitlistEntry" ("shopId", "status", "tierRank", "createdAt", "id");
