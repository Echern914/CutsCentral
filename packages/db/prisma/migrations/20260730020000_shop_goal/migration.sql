-- Shop quota goal (Insights): ONE active goal per shop — "$4,000 this month" /
-- "60 cuts this week". The row stores only the target; progress is computed at
-- read time from COMPLETED Visits (the same source as the Insights totals), and
-- period windows are derived in the shop's timezone. Editing the goal updates
-- the row in place (unique shopId).

-- CreateEnum
CREATE TYPE "GoalMetric" AS ENUM ('revenue', 'visits');
CREATE TYPE "GoalPeriod" AS ENUM ('week', 'month');

-- CreateTable
CREATE TABLE "ShopGoal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "metric" "GoalMetric" NOT NULL,
    "period" "GoalPeriod" NOT NULL,
    "target" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopGoal_shopId_key" ON "ShopGoal"("shopId");

-- AddForeignKey
ALTER TABLE "ShopGoal" ADD CONSTRAINT "ShopGoal_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ShopGoal" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ShopGoal']
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
