-- Square Appointments connection (mirrors AcuityConnection). One per shop; holds
-- the encrypted OAuth tokens + Square merchant/location ids.

-- CreateTable
CREATE TABLE "SquareConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "squareMerchantId" TEXT NOT NULL,
    "squareLocationId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'APPOINTMENTS_READ APPOINTMENTS_ALL_READ CUSTOMERS_READ MERCHANT_PROFILE_READ',
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquareConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquareConnection_shopId_key" ON "SquareConnection"("shopId");

-- CreateIndex
CREATE INDEX "SquareConnection_squareMerchantId_idx" ON "SquareConnection"("squareMerchantId");

-- AddForeignKey
ALTER TABLE "SquareConnection" ADD CONSTRAINT "SquareConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: SquareConnection is a SECRETS table looked up by the trusted server (by
-- shopId / merchant_id), NOT a per-shop tenant table. So mirror AcuityConnection
-- (the 20260609000000_rls_lockdown_non_tenant_tables pattern): ENABLE RLS only —
-- NO FORCE, NO policy, NO GRANT to chairback_app. The app connects as the table
-- OWNER (postgres), which bypasses non-forced RLS and keeps full access; the
-- Supabase data-API roles get default-deny, closing the rls_disabled advisory.
ALTER TABLE "SquareConnection" ENABLE ROW LEVEL SECURITY;
