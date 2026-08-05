-- Goal planner: the Insights goals grow from bare targets into plans.
--   * GoalMetric gains chairTime (a target utilization %, ShopGoal only).
--   * GoalPeriod gains overall (a standing level target with no calendar
--     window - what a percentage target actually is).
--   * ShopGoal.plan stores the planner's saved levers ({ bookedPct,
--     services: [{ serviceId, priceDelta, extraCuts }] }) so the plan the
--     barber built survives reload. JSON, never queried server-side.
--   * ServiceGoal: per-service quotas ("12 fades a week") for the By-service
--     view. A separate table rather than a nullable serviceId on ShopGoal:
--     Postgres unique indexes treat NULLs as distinct, so a nullable column
--     inside the compound unique would admit duplicate shop-wide rows and
--     Prisma couldn't upsert on the key at all.

-- AlterEnum (PG12+ allows ADD VALUE in a transaction as long as the new value
-- isn't used in the same transaction - it isn't).
ALTER TYPE "GoalMetric" ADD VALUE 'chairTime';
ALTER TYPE "GoalPeriod" ADD VALUE 'overall';

-- AlterTable
ALTER TABLE "ShopGoal" ADD COLUMN "plan" JSONB;

-- CreateTable
CREATE TABLE "ServiceGoal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "metric" "GoalMetric" NOT NULL,
    "period" "GoalPeriod" NOT NULL,
    "target" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceGoal_shopId_serviceId_metric_period_key"
  ON "ServiceGoal"("shopId", "serviceId", "metric", "period");
CREATE INDEX "ServiceGoal_shopId_idx" ON "ServiceGoal"("shopId");

-- AddForeignKey
ALTER TABLE "ServiceGoal" ADD CONSTRAINT "ServiceGoal_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceGoal" ADD CONSTRAINT "ServiceGoal_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceGoal" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ServiceGoal']
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
