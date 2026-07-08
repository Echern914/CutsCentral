-- Service add-ons: optional extras a customer tacks onto a service at booking
-- (+ beard trim, + hot towel). Each adds durationMin to the appointment length
-- and price to the total. The chosen add-ons are snapshotted onto
-- Appointment.addOns so editing/deleting an add-on never rewrites a past booking.

-- CreateTable
CREATE TABLE "ServiceAddOn" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceAddOn_shopId_active_idx" ON "ServiceAddOn"("shopId", "active");
CREATE INDEX "ServiceAddOn_shopId_serviceId_idx" ON "ServiceAddOn"("shopId", "serviceId");

-- AddForeignKey. serviceId null = the add-on is offered on every service; a set
-- serviceId scopes it to one service and cascades if that service is deleted.
ALTER TABLE "ServiceAddOn" ADD CONSTRAINT "ServiceAddOn_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceAddOn" ADD CONSTRAINT "ServiceAddOn_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: itemized snapshot of the add-ons chosen at booking. endsAt +
-- priceAtBooking already fold in the totals; this preserves the list for display.
ALTER TABLE "Appointment" ADD COLUMN "addOns" JSONB NOT NULL DEFAULT '[]';

-- RLS defense-in-depth: same tenant-isolation pattern as the other booking tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceAddOn" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ServiceAddOn']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
