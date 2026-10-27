-- FILL CANCELLATIONS: after the Gold members' head start, Auto-fill tells
-- EVERY client of the shop who has the app that the time is open, and the
-- first one to book it on the booking page gets it.
--
-- Additive. One more state for a run ('everyone': telling everyone, a batch
-- per sweep), and one new table: who a run is telling, so each person hears
-- at most once per opening and a restart picks up where the sends stopped.
-- 'silver' stays allowed so a run already in that state still finishes.

ALTER TABLE "AutoFillRun" DROP CONSTRAINT "AutoFillRun_state_check";
ALTER TABLE "AutoFillRun" ADD CONSTRAINT "AutoFillRun_state_check"
  CHECK ("state" IN ('queued', 'gold', 'silver', 'everyone', 'closed'));

-- One row per person a run tells in its 'everyone' stage. Frozen when the
-- stage begins, under the shop's invitation lock, so the per-person caps read
-- by the next run count these too.
--   notifiedAt - when a send was CLAIMED for this person (NULL = not yet). A
--                compare-and-set from NULL is what makes it one push, ever.
--   delivered  - whether any of their phones accepted it (NULL = not sent).
-- shopId is a copy for the caps' read; the rows go with their run, and the run
-- goes with its shop.
CREATE TABLE "AutoFillRecipient" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "delivered" BOOLEAN,

    CONSTRAINT "AutoFillRecipient_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutoFillRecipient_delivered_check" CHECK ("delivered" IS NULL OR "notifiedAt" IS NOT NULL)
);

-- One person, one notification per opening - however many records they have here.
CREATE UNIQUE INDEX "AutoFillRecipient_runId_accountId_key" ON "AutoFillRecipient"("runId", "accountId");
-- The caps: everything one person was told by one shop in the last week.
CREATE INDEX "AutoFillRecipient_accountId_shopId_createdAt_idx" ON "AutoFillRecipient"("accountId", "shopId", "createdAt");
-- The sends still owed.
CREATE INDEX "AutoFillRecipient_unsent_idx" ON "AutoFillRecipient"("runId", "createdAt") WHERE "notifiedAt" IS NULL;

ALTER TABLE "AutoFillRecipient" ADD CONSTRAINT "AutoFillRecipient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoFillRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoFillRecipient" ADD CONSTRAINT "AutoFillRecipient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoFillRecipient" ADD CONSTRAINT "AutoFillRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* 🔴 PLATFORM-OWNED, like TierOpeningRecipient: it joins a shop record to a
   person's own account, so a shop session must not be able to read it. No
   policy: FORCE + REVOKE = default deny. */
REVOKE ALL ON "AutoFillRecipient" FROM chairback_app;
ALTER TABLE "AutoFillRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutoFillRecipient" FORCE ROW LEVEL SECURITY;
