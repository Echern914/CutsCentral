-- Drick's booking feedback round:
--  1. Add-ons offered on SEVERAL services (serviceIds[] replaces the single
--     nullable serviceId; [] = every service, matching the old null).
--  2. Per-group service ordering (Service.groupSortOrder, stamped from the
--     order the group's serviceIds are saved in).
--  3. Groups-first public booking menu (Shop.bookingGroupsFirst, default off).
--  4. Targeted-slot SERIES: TargetedSlotRule ("every Sunday 3pm"), finite
--     batches for grouping/series-delete, indefinite ones ("until I turn it
--     off") rolled forward by the targeted-slot-roll-forward scheduler job.

-- 1. Add-ons: single service -> service list. Backfill scoped rows as a
--    one-element list, then drop the old column (its index + FK go with it).
ALTER TABLE "ServiceAddOn" ADD COLUMN "serviceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "ServiceAddOn" SET "serviceIds" = ARRAY["serviceId"] WHERE "serviceId" IS NOT NULL;
DROP INDEX IF EXISTS "ServiceAddOn_shopId_serviceId_idx";
ALTER TABLE "ServiceAddOn" DROP CONSTRAINT IF EXISTS "ServiceAddOn_serviceId_fkey";
ALTER TABLE "ServiceAddOn" DROP COLUMN "serviceId";

-- 2. Order within a group (0-based; meaningless while ungrouped).
ALTER TABLE "Service" ADD COLUMN "groupSortOrder" INTEGER NOT NULL DEFAULT 0;

-- 3. Groups-first public menu, default off (no existing page changes).
ALTER TABLE "Shop" ADD COLUMN "bookingGroupsFirst" BOOLEAN NOT NULL DEFAULT false;

-- 4. Targeted-slot series rule + row link.
CREATE TABLE "TargetedSlotRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "label" TEXT,
    "anchor" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "indefinite" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "weeksMaterialized" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetedSlotRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TargetedSlotRule_shopId_active_idx" ON "TargetedSlotRule"("shopId", "active");

ALTER TABLE "TargetedSlotRule" ADD CONSTRAINT "TargetedSlotRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotRule" ADD CONSTRAINT "TargetedSlotRule_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotRule" ADD CONSTRAINT "TargetedSlotRule_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row -> rule link. SetNull keeps booked/past rows as history if a rule is
-- ever hard-deleted (turn-off only deactivates).
ALTER TABLE "TargetedSlot" ADD COLUMN "ruleId" TEXT;
CREATE INDEX "TargetedSlot_ruleId_idx" ON "TargetedSlot"("ruleId");
ALTER TABLE "TargetedSlot" ADD CONSTRAINT "TargetedSlot_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "TargetedSlotRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other booking tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "TargetedSlotRule" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['TargetedSlotRule']
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

-- Seed the roll-forward job's lease row (same pattern as every other job).
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('targeted-slot-roll-forward', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
