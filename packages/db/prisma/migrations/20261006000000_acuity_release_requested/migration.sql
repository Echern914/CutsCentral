-- The release INTENT, made durable and kept separate from the release STATE.
--
-- 🔴 THE BUG THIS EXISTS FOR. `releaseForAppointment` and `releaseAllForShop`
-- both flipped every non-terminal row to RELEASING before calling releaseRow:
--
--     data: { state: "RELEASING" }          -- UNKNOWN overwritten here
--     for (const row of rows) await releaseRow(row.id);
--
-- and releaseRow then re-read the row and asked:
--
--     if (!row.acuityBlockId) {
--       if (row.state === "UNKNOWN") return;   -- can never be true
--       ... state: "RELEASED"
--
-- The guard could not fire, because the state it tested for had been
-- overwritten one statement earlier. An ambiguous create - one where we asked
-- Acuity for a block and never heard back - was therefore marked RELEASED
-- while holding no block id and having deleted nothing.
--
-- The reconciler only scans PENDING | UNKNOWN | RELEASING, so a row marked
-- RELEASED is never looked at again. If that block DID exist in Acuity it is
-- now orphaned: the barber's calendar stays blocked forever over a chair
-- ChairBack believes is free. That is the exact inverse of the exposure this
-- engine was built to close.
--
-- Overwriting the state was the mistake, so the intent moves off the state
-- machine and into its own column. A row can now be BOTH "we do not know what
-- exists remotely" (state = UNKNOWN) AND "whatever exists must be deleted"
-- (releaseRequested = true), which is the situation that actually occurs and
-- which one enum value could never represent.

ALTER TABLE "AcuityOutboundBlock"
  ADD COLUMN "releaseRequested" BOOLEAN NOT NULL DEFAULT false;

-- 🔴 AND A CLOCK THAT MEASURES THE RIGHT THING.
--
-- Deciding "the block is not in Acuity's listing, so it does not exist" is
-- only safe once the listing has had time to show it - otherwise a lookup
-- landing seconds after the create reads a live block as absent and we mark
-- it RELEASED, orphaning the exact thing we were asked to delete.
--
-- That judgement needs "how long since we asked Acuity to create this".
-- `updatedAt` cannot answer it: it moves on every write, so simply recording
-- the release intent reset it, and the row's absence would never become
-- authoritative no matter how long it really had been. This column moves only
-- when a create request is genuinely put in front of Acuity.
ALTER TABLE "AcuityOutboundBlock"
  ADD COLUMN "lastCreateAttemptAt" TIMESTAMP(3);

/* Existing rows that have been dispatched get the best available answer:
   `updatedAt` today is at worst too RECENT for them (nothing has written to
   these rows since their dispatch), which errs towards "not yet settled" -
   the safe direction. Rows never dispatched keep NULL and need no clock. */
UPDATE "AcuityOutboundBlock"
   SET "lastCreateAttemptAt" = "updatedAt"
 WHERE "attempts" > 0;

/* The reconciler's new work queue: an ambiguous create somebody has since
   asked to be released. Partial, because it is a small slice of a table that
   is mostly terminal rows. */
CREATE INDEX "AcuityOutboundBlock_releaseRequested_idx"
  ON "AcuityOutboundBlock" ("shopId", "state")
  WHERE "releaseRequested" = true;

-- 🔴 NO BACKFILL, AND THAT IS DELIBERATE.
--
-- Rows already marked RELEASED cannot be un-marked here: this migration cannot
-- tell a row that was correctly released (block deleted, 404 confirmed, or
-- never dispatched at all) from one that was falsely released by the bug. The
-- only way to separate them is to ask Acuity, per row, per shop - which is a
-- network operation and has no business inside a schema migration.
--
-- Any block orphaned before this deploy therefore stays orphaned until
-- somebody runs the coverage audit (`POST /acuity/coverage-audit`) against the
-- affected shops. That is a deliberate, reviewable operator action, not a side
-- effect of a deploy.
