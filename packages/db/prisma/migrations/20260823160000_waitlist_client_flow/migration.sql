-- Waitlist phase B: the client flow.
--
-- PR A added the shape. This adds the three columns the join route needs and
-- the constraint that makes "one place per request" a database fact rather
-- than a check-then-insert race.
--
-- Additive only. All 118 backfilled "Any date / Any time" entries keep working
-- exactly as they do: their new columns are NULL, and NULLs are distinct under
-- the partial unique index below, so none of them can collide with each other
-- or with anything new.

ALTER TABLE "WaitlistEntry"
  -- WHICH consent sentence they agreed to. "They ticked a box in August" is
  -- worth very little in a carrier or FTC complaint; "they ticked this exact
  -- text, v1, at this time, from this number" is worth a great deal.
  ADD COLUMN "smsConsentVersion" TEXT,
  -- The number that consented, snapshotted. "phone" can be edited later and a
  -- consent record pointing at whatever it says now is not evidence.
  ADD COLUMN "smsConsentPhone"   TEXT,
  -- Fingerprint of contact + service + provider + preferences.
  ADD COLUMN "dedupeKey"         TEXT;

-- 🔑 ONE ACTIVE PLACE PER REQUEST.
--
-- Partial on the ACTIVE statuses only, which is what makes it correct rather
-- than merely strict:
--   - a customer who CANCELS frees their key and can rejoin;
--   - a BOOKED or REMOVED entry stops blocking;
--   - a genuinely different request (Saturday as well as Tuesday) has a
--     different key, because preferences are part of it, and is allowed.
--
-- Same shape as the appointment double-booking guard and PR A's offer
-- constraint: the rule lives in the database, so no caller can forget it and
-- no race can slip between the check and the insert.
CREATE UNIQUE INDEX "WaitlistEntry_one_active_per_request"
  ON "WaitlistEntry"("shopId", "dedupeKey")
  WHERE "status" IN ('WAITING', 'CONTACTED');

-- The consent audit query ("who agreed to what, and when") and the 10DLC
-- evidence export both filter on this.
CREATE INDEX "WaitlistEntry_shopId_smsConsentAt_idx"
  ON "WaitlistEntry"("shopId", "smsConsentAt")
  WHERE "smsConsentAt" IS NOT NULL;
