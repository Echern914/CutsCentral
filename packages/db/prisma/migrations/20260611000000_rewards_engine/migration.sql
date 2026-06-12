-- Rewards engine: per-shop reward MENU (Reward) + configurable earning
-- (Shop.punchesPerVisit base rate, EarnRule service overrides), and redemptions
-- linked to the reward they bought (PunchLedger.rewardId).
--
-- Shop.rewardThreshold / rewardLabel become legacy: kept (with defaults) so the
-- currently deployed API keeps working until the new code ships; the backfill
-- below converts them into each shop's first Reward row.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "punchesPerVisit" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "emoji" TEXT,
    "punchCost" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceMatch" TEXT NOT NULL,
    "punches" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarnRule_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PunchLedger" ADD COLUMN "rewardId" TEXT;

-- CreateIndex
CREATE INDEX "Reward_shopId_active_idx" ON "Reward"("shopId", "active");

-- CreateIndex
CREATE INDEX "EarnRule_shopId_active_idx" ON "EarnRule"("shopId", "active");

-- CreateIndex
CREATE INDEX "PunchLedger_rewardId_idx" ON "PunchLedger"("rewardId");

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnRule" ADD CONSTRAINT "EarnRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as Client/Visit/etc.
-- (chairback_app grants arrive via ALTER DEFAULT PRIVILEGES from the first RLS
-- migration; repeated explicitly here so this migration stands alone.)
GRANT SELECT, INSERT, UPDATE, DELETE ON "Reward", "EarnRule" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Reward', 'EarnRule']
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

-- Backfill: every existing shop's legacy single reward becomes the first item
-- on its menu (idempotent: only for shops with no Reward rows yet).
INSERT INTO "Reward" ("id", "shopId", "name", "punchCost", "active", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, s."id", s."rewardLabel", s."rewardThreshold", true, 0, CURRENT_TIMESTAMP
FROM "Shop" s
WHERE NOT EXISTS (SELECT 1 FROM "Reward" r WHERE r."shopId" = s."id");
