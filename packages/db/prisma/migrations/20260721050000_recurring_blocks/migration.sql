-- Recurring weekly block-offs: the mirror of AvailabilityRule (same shop-local
-- minutes-from-midnight shape) but SUBTRACTED from availability, so "every
-- Monday 12:00-13:30 is blocked" is set once and repeats each week. Stored as
-- local minutes (not UTC instants) so the concrete instant is computed per date
-- and stays DST-correct. The slot engine subtracts these in computeOpenSlots.

CREATE TABLE "RecurringBlock" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecurringBlock_shopId_staffId_weekday_idx" ON "RecurringBlock"("shopId", "staffId", "weekday");

ALTER TABLE "RecurringBlock" ADD CONSTRAINT "RecurringBlock_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringBlock" ADD CONSTRAINT "RecurringBlock_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: the standard shopId FORCE-RLS block every tenant table gets
-- (pattern: 20260622110000_native_booking / 20260712130000_targeted_slots).
GRANT SELECT, INSERT, UPDATE, DELETE ON "RecurringBlock" TO chairback_app;
ALTER TABLE "RecurringBlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecurringBlock" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RecurringBlock";
CREATE POLICY tenant_isolation ON "RecurringBlock"
    USING ("shopId" = current_shop_id())
    WITH CHECK ("shopId" = current_shop_id());
