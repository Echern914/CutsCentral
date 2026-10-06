-- AUTO-FILL: when a client cancels, the freed time is offered in the app to the
-- shop's Gold members, then Silver, then the waitlist, then anyone.
--
-- Additive. One switch on Shop (off for every shop), a source tag on
-- TierOpening, send stamps on TierOpeningRecipient, and one new table that
-- carries a cancellation through those stages. Nothing existing changes shape,
-- and no status CHECK is rewritten: a hold still ends the way it always has,
-- by its heldUntil passing.

ALTER TABLE "Shop" ADD COLUMN "autoFillEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Who made the hold: the barber by hand, or Auto-fill.
ALTER TABLE "TierOpening" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "TierOpening" ADD CONSTRAINT "TierOpening_source_check" CHECK ("source" IN ('manual', 'auto'));

-- Each invitation now records whether it was sent, so a push is sent at most
-- once, sending stops when the opening ends, and a send lost to a restart is
-- picked up again.
--   wave       - which Auto-fill stage invited them (NULL for a manual opening)
--   notifiedAt - when a send was claimed for this person (NULL = not yet)
--   delivered  - whether any of their devices accepted it (NULL = not sent)
ALTER TABLE "TierOpeningRecipient" ADD COLUMN "wave" TEXT;
ALTER TABLE "TierOpeningRecipient" ADD COLUMN "notifiedAt" TIMESTAMP(3);
ALTER TABLE "TierOpeningRecipient" ADD COLUMN "delivered" BOOLEAN;
ALTER TABLE "TierOpeningRecipient" ADD CONSTRAINT "TierOpeningRecipient_wave_check"
  CHECK ("wave" IS NULL OR "wave" IN ('gold', 'silver'));
ALTER TABLE "TierOpeningRecipient" ADD CONSTRAINT "TierOpeningRecipient_delivered_check"
  CHECK ("delivered" IS NULL OR "notifiedAt" IS NOT NULL);

-- Every invitation that exists today was sent when its opening was made.
UPDATE "TierOpeningRecipient" SET "notifiedAt" = "createdAt";

-- The resend sweep's question: who was invited but never sent to?
CREATE INDEX "TierOpeningRecipient_unnotified_idx"
  ON "TierOpeningRecipient"("createdAt") WHERE "notifiedAt" IS NULL;

-- ONE ROW PER CANCELLATION Auto-fill works on, written in the same transaction
-- as the cancellation itself, so a restart between the two cannot lose it.
--
-- triggerKey is cancel:{appointmentId}:r{cancellationRevision}. The revision is
-- the cancellation's own persisted counter, so the same cancellation can never
-- start two runs, while a cancel, undo, cancel again starts a second one.
CREATE TABLE "AutoFillRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "nextAt" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "openingId" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoFillRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutoFillRun_state_check" CHECK ("state" IN ('queued', 'gold', 'silver', 'closed')),
    -- A run that is still going is always due at some time, and a finished one
    -- never is: the sweep cannot lose a live run or wake a closed one.
    CONSTRAINT "AutoFillRun_due_check" CHECK (("state" = 'closed') = ("nextAt" IS NULL)),
    -- And a finished run always says how it finished.
    CONSTRAINT "AutoFillRun_outcome_check" CHECK (("state" = 'closed') = ("outcome" IS NOT NULL)),
    CONSTRAINT "AutoFillRun_span_check" CHECK ("endsAt" > "startsAt")
);

CREATE UNIQUE INDEX "AutoFillRun_triggerKey_key" ON "AutoFillRun"("triggerKey");
CREATE UNIQUE INDEX "AutoFillRun_openingId_key" ON "AutoFillRun"("openingId");
CREATE INDEX "AutoFillRun_shopId_createdAt_idx" ON "AutoFillRun"("shopId", "createdAt");
CREATE INDEX "AutoFillRun_appointmentId_idx" ON "AutoFillRun"("appointmentId");
-- The sweep reads only runs still in progress.
CREATE INDEX "AutoFillRun_due_idx" ON "AutoFillRun"("nextAt") WHERE "state" <> 'closed';

ALTER TABLE "AutoFillRun" ADD CONSTRAINT "AutoFillRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE, not RESTRICT: the demo shop's nightly reset hard-deletes appointments.
ALTER TABLE "AutoFillRun" ADD CONSTRAINT "AutoFillRun_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoFillRun" ADD CONSTRAINT "AutoFillRun_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "TierOpening"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/* The run is the shop's: tenant isolation, like TierOpening. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "AutoFillRun" TO chairback_app;
ALTER TABLE "AutoFillRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutoFillRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AutoFillRun";
CREATE POLICY tenant_isolation ON "AutoFillRun"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
