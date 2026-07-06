-- AlterTable
ALTER TABLE "PunchLedger" ADD COLUMN     "cardTypeId" TEXT;

-- AlterTable
ALTER TABLE "Reward" ADD COLUMN     "cardTypeId" TEXT;

-- CreateTable
CREATE TABLE "CardType" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "emoji" TEXT,
    "accentColor" TEXT,
    "serviceMatch" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "punchesPerVisit" INTEGER NOT NULL DEFAULT 1,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardGrant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cardTypeId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardType_shopId_active_idx" ON "CardType"("shopId", "active");

-- CreateIndex
CREATE INDEX "CardGrant_shopId_clientId_idx" ON "CardGrant"("shopId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CardGrant_cardTypeId_clientId_key" ON "CardGrant"("cardTypeId", "clientId");

-- CreateIndex
CREATE INDEX "PunchLedger_cardTypeId_idx" ON "PunchLedger"("cardTypeId");

-- CreateIndex
CREATE INDEX "Reward_cardTypeId_idx" ON "Reward"("cardTypeId");

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_cardTypeId_fkey" FOREIGN KEY ("cardTypeId") REFERENCES "CardType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardType" ADD CONSTRAINT "CardType_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardGrant" ADD CONSTRAINT "CardGrant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardGrant" ADD CONSTRAINT "CardGrant_cardTypeId_fkey" FOREIGN KEY ("cardTypeId") REFERENCES "CardType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardGrant" ADD CONSTRAINT "CardGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_cardTypeId_fkey" FOREIGN KEY ("cardTypeId") REFERENCES "CardType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as Reward/EarnRule
-- (chairback_app grants arrive via ALTER DEFAULT PRIVILEGES from the first RLS
-- migration; repeated explicitly here so this migration stands alone.)
GRANT SELECT, INSERT, UPDATE, DELETE ON "CardType", "CardGrant" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CardType', 'CardGrant']
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

-- No backfill: existing PunchLedger/Reward rows keep cardTypeId NULL, which IS
-- the shop's default card. Every current shop keeps working unchanged.
