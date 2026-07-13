-- Targeted slots: barber-published one-off bookable slots with their own
-- time/duration/price under a parent service. Capacity exactly 1 (the unique
-- bookedAppointmentId claim); active+unbooked rows block normal bookings via
-- the shared guard in engines/bookingWrite.ts.

CREATE TABLE "TargetedSlot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "label" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bookedAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetedSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetedSlot_bookedAppointmentId_key" ON "TargetedSlot"("bookedAppointmentId");
CREATE INDEX "TargetedSlot_shopId_staffId_startsAt_idx" ON "TargetedSlot"("shopId", "staffId", "startsAt");
CREATE INDEX "TargetedSlot_shopId_serviceId_startsAt_idx" ON "TargetedSlot"("shopId", "serviceId", "startsAt");

ALTER TABLE "TargetedSlot" ADD CONSTRAINT "TargetedSlot_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlot" ADD CONSTRAINT "TargetedSlot_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlot" ADD CONSTRAINT "TargetedSlot_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlot" ADD CONSTRAINT "TargetedSlot_bookedAppointmentId_fkey"
    FOREIGN KEY ("bookedAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation: the standard shopId FORCE-RLS block every tenant table gets
-- (pattern: 20260622110000_native_booking).
GRANT SELECT, INSERT, UPDATE, DELETE ON "TargetedSlot" TO chairback_app;
ALTER TABLE "TargetedSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TargetedSlot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TargetedSlot";
CREATE POLICY tenant_isolation ON "TargetedSlot"
    USING ("shopId" = current_shop_id())
    WITH CHECK ("shopId" = current_shop_id());
