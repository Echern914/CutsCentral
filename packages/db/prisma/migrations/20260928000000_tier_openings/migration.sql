-- Openings held for a loyalty tier: the barber pushes a free slot to his Gold
-- (or Silver-and-up, or every tier) members, it is theirs to book in the app
-- until heldUntil, and then it is back on the booking page for anyone.
--
-- Additive: two new tables. Nothing existing changes shape.

CREATE TABLE "TierOpening" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "minTier" "LoyaltyTier" NOT NULL,
    "heldUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "claimedAppointmentId" TEXT,
    "createdByUserId" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierOpening_pkey" PRIMARY KEY ("id"),
    -- The three states the engine writes, and nothing else.
    CONSTRAINT "TierOpening_status_check" CHECK ("status" IN ('HELD', 'CLAIMED', 'RELEASED')),
    CONSTRAINT "TierOpening_span_check" CHECK ("endsAt" > "startsAt"),
    -- A hold that outlived its own appointment time would never become
    -- "then anyone": the slot would simply be lost to everyone who wasn't told.
    CONSTRAINT "TierOpening_hold_before_start_check" CHECK ("heldUntil" <= "startsAt")
);

CREATE TABLE "TierOpeningRecipient" (
    "id" TEXT NOT NULL,
    "openingId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TierOpeningRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TierOpening_claimedAppointmentId_key" ON "TierOpening"("claimedAppointmentId");
CREATE INDEX "TierOpening_shopId_staffId_status_heldUntil_idx" ON "TierOpening"("shopId", "staffId", "status", "heldUntil");
CREATE INDEX "TierOpening_shopId_createdAt_idx" ON "TierOpening"("shopId", "createdAt");
CREATE INDEX "TierOpeningRecipient_accountId_createdAt_idx" ON "TierOpeningRecipient"("accountId", "createdAt");
-- One invitation per person per opening: a person linked to two records at the
-- same shop is still one person with one chance at the slot.
CREATE UNIQUE INDEX "TierOpeningRecipient_openingId_accountId_key" ON "TierOpeningRecipient"("openingId", "accountId");

ALTER TABLE "TierOpening" ADD CONSTRAINT "TierOpening_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TierOpening" ADD CONSTRAINT "TierOpening_claimedAppointmentId_fkey" FOREIGN KEY ("claimedAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TierOpeningRecipient" ADD CONSTRAINT "TierOpeningRecipient_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "TierOpening"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TierOpeningRecipient" ADD CONSTRAINT "TierOpeningRecipient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TierOpeningRecipient" ADD CONSTRAINT "TierOpeningRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* The opening is the shop's: tenant isolation, like every other shop table. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "TierOpening" TO chairback_app;
ALTER TABLE "TierOpening" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TierOpening" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TierOpening";
CREATE POLICY tenant_isolation ON "TierOpening"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

/* 🔴 The invitation list is PLATFORM-owned. It joins a shop record to a
   person's own account, so a shop session must not be able to read it - the
   same rule as CustomerClientLink. No policy: FORCE + REVOKE = default deny. */
REVOKE ALL ON "TierOpeningRecipient" FROM chairback_app;
ALTER TABLE "TierOpeningRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TierOpeningRecipient" FORCE ROW LEVEL SECURITY;
