/* ------------------------------------------------------------------ *
 * The founder's personal trial check-in (engines/trialCheckIn.ts).
 * ------------------------------------------------------------------ */

-- 1. When the note went (null = not yet). Compare-and-set before sending.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "trialCheckInSentAt" TIMESTAMP(3);

-- 2. Starts with trials that end from now on. A shop whose trial has already
--    ended is marked as done, so nobody the founder has already written to by
--    hand gets a second, automated copy of the same note.
UPDATE "Shop"
SET "trialCheckInSentAt" = now()
WHERE "trialEndsAt" IS NOT NULL
  AND "trialEndsAt" <= now()
  AND "trialCheckInSentAt" IS NULL;

-- 3. The daily job. A scheduled job whose name has no job_lease row NEVER
--    runs - withLease acquires by UPDATE only.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('trial-check-in', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
