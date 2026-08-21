-- Targeted slots can be offered under SEVERAL services.
--
-- "This 8:30 PM hour is available as a retwist OR a line-up" could not be
-- said: a slot carried exactly one serviceId, so a barber wanting two had to
-- publish two slots - which is two availability records for ONE physical hour,
-- and booking one left the other bookable. That is a double-book.
--
-- 🔑 THE SLOT ROW STAYS SINGULAR. Capacity lives on TargetedSlot
-- (bookedAppointmentId is UNIQUE), so one row per physical time means booking
-- it as ANY of its services consumes it for all of them. Shared capacity is a
-- property of the shape, not of code that has to remember. The join below only
-- says which services LIST it.
--
-- TargetedSlot.serviceId and TargetedSlotRule.serviceId are NOT dropped. They
-- stay populated with the first service so the columns, their indexes and the
-- FKs remain valid and the pre-multi value stays recoverable - the same call
-- made when hours moved off ServiceGroup. Nothing reads them for listing after
-- this; the join is authoritative.

CREATE TABLE "TargetedSlotService" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetedSlotService_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TargetedSlotRuleService" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetedSlotRuleService_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetedSlotService_slotId_serviceId_key"
  ON "TargetedSlotService"("slotId", "serviceId");
CREATE INDEX "TargetedSlotService_shopId_serviceId_idx"
  ON "TargetedSlotService"("shopId", "serviceId");

CREATE UNIQUE INDEX "TargetedSlotRuleService_ruleId_serviceId_key"
  ON "TargetedSlotRuleService"("ruleId", "serviceId");
CREATE INDEX "TargetedSlotRuleService_shopId_serviceId_idx"
  ON "TargetedSlotRuleService"("shopId", "serviceId");

ALTER TABLE "TargetedSlotService" ADD CONSTRAINT "TargetedSlotService_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotService" ADD CONSTRAINT "TargetedSlotService_slotId_fkey"
  FOREIGN KEY ("slotId") REFERENCES "TargetedSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotService" ADD CONSTRAINT "TargetedSlotService_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetedSlotRuleService" ADD CONSTRAINT "TargetedSlotRuleService_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotRuleService" ADD CONSTRAINT "TargetedSlotRuleService_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "TargetedSlotRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetedSlotRuleService" ADD CONSTRAINT "TargetedSlotRuleService_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL. Every existing slot and rule gets exactly one listing, its current
-- service, so behaviour is byte-for-byte unchanged the moment this lands. This
-- is the whole "safe migration from one service ID to multiple": the old value
-- becomes a one-element set, nothing is dropped, and no slot changes which
-- service it appears under.
--
-- gen_random_uuid()::text for the id: cuid() is application-side, and these
-- rows are never addressed by id (the unique is on the pair).
INSERT INTO "TargetedSlotService" ("id", "shopId", "slotId", "serviceId", "createdAt")
SELECT gen_random_uuid()::text, t."shopId", t."id", t."serviceId", now()
FROM "TargetedSlot" t
ON CONFLICT ("slotId", "serviceId") DO NOTHING;

INSERT INTO "TargetedSlotRuleService" ("id", "shopId", "ruleId", "serviceId", "createdAt")
SELECT gen_random_uuid()::text, r."shopId", r."id", r."serviceId", now()
FROM "TargetedSlotRule" r
ON CONFLICT ("ruleId", "serviceId") DO NOTHING;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "TargetedSlotService" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TargetedSlotRuleService" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['TargetedSlotService', 'TargetedSlotRuleService']
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
