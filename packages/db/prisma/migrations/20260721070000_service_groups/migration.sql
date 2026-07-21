-- Service groups: bundle several services under ONE shared config (Acuity-style).
-- The group's hoursWindows OVERRIDE each member service's own hoursWindows, and
-- its maxPerDay/maxConcurrent caps (either null = no cap) apply across all
-- members combined. Deleting a group SETs NULL on its members (services survive).
-- Enforced in the slot engine (computeOpenSlots), the choke-point for both the
-- picker grid and the isSlotBookable write-path gate.

-- CreateTable
CREATE TABLE "ServiceGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hoursWindows" JSONB NOT NULL DEFAULT '{}',
    "maxPerDay" INTEGER,
    "maxConcurrent" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceGroup_shopId_active_idx" ON "ServiceGroup"("shopId", "active");

-- AlterTable: nullable membership FK. null = standalone service (the default for
-- every existing row); set = the group's hours/limits govern this service.
ALTER TABLE "Service" ADD COLUMN "serviceGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Service_shopId_serviceGroupId_idx" ON "Service"("shopId", "serviceGroupId");

-- AddForeignKey. Deleting a group SETs NULL on its members (never deletes them).
ALTER TABLE "ServiceGroup" ADD CONSTRAINT "ServiceGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Service" ADD CONSTRAINT "Service_serviceGroupId_fkey" FOREIGN KEY ("serviceGroupId") REFERENCES "ServiceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other booking tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceGroup" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ServiceGroup']
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
