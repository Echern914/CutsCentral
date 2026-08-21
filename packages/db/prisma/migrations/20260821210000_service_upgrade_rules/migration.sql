-- Barber-configured upgrade prompts.
--
-- GET /api/book/:slug/upgrades already offers upsells and already confirms each
-- one against the real availability engine. What it could not do was let the
-- barber SAY which upsell belongs on which service - it derived candidates as
-- "longer AND dearer, offered by this barber", which will happily push a beard
-- trim at someone booking a kids' cut.
--
-- Purely additive. No existing row changes, and a shop with no rules keeps
-- exactly today's automatic behaviour (see the endpoint) rather than silently
-- losing its upsells.

CREATE TABLE "ServiceUpgradeRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "destinationServiceId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceUpgradeRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceUpgradeRuleSource" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceUpgradeRuleSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceUpgradeRule_shopId_active_idx"
  ON "ServiceUpgradeRule"("shopId", "active");
CREATE UNIQUE INDEX "ServiceUpgradeRuleSource_ruleId_serviceId_key"
  ON "ServiceUpgradeRuleSource"("ruleId", "serviceId");
-- "what can THIS service be upgraded to" - the booking-page lookup.
CREATE INDEX "ServiceUpgradeRuleSource_shopId_serviceId_idx"
  ON "ServiceUpgradeRuleSource"("shopId", "serviceId");

ALTER TABLE "ServiceUpgradeRule" ADD CONSTRAINT "ServiceUpgradeRule_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceUpgradeRule" ADD CONSTRAINT "ServiceUpgradeRule_destinationServiceId_fkey"
  FOREIGN KEY ("destinationServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceUpgradeRuleSource" ADD CONSTRAINT "ServiceUpgradeRuleSource_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceUpgradeRuleSource" ADD CONSTRAINT "ServiceUpgradeRuleSource_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "ServiceUpgradeRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceUpgradeRuleSource" ADD CONSTRAINT "ServiceUpgradeRuleSource_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceUpgradeRule" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceUpgradeRuleSource" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ServiceUpgradeRule', 'ServiceUpgradeRuleSource']
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
