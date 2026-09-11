-- "Not the same person": a reviewed pair of flagged duplicates that must not be
-- flagged again. Additive only.

CREATE TABLE "ClientDuplicateDismissal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientAId" TEXT NOT NULL,
    "clientBId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDuplicateDismissal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientDuplicateDismissal_shopId_clientAId_clientBId_key"
  ON "ClientDuplicateDismissal"("shopId", "clientAId", "clientBId");
ALTER TABLE "ClientDuplicateDismissal"
  ADD CONSTRAINT "ClientDuplicateDismissal_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* One pair, one row: the lower id is always A. Byte order ("C"), the order
   the API sorts in - a locale collation can order ids differently. */
ALTER TABLE "ClientDuplicateDismissal"
  ADD CONSTRAINT "ClientDuplicateDismissal_ordered_pair"
  CHECK ("clientAId" COLLATE "C" < "clientBId" COLLATE "C");

/* 🔴 BOTH RECORDS MUST BE THIS SHOP'S.

   "These two are different people" is a decision about two of a shop's own
   clients, and the customer-linking engine reads it: a dismissed record is
   never linked to an account by a shared contact again. A row pairing this
   shop with another shop's client would therefore reach across tenants and
   silently change what a customer elsewhere can see.

   Created only if absent - PR #413 and the My ChairBack migration add the
   same Client constraint under the same name. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Client_id_shopId_key' AND conrelid = '"Client"'::regclass
  ) THEN
    ALTER TABLE "Client" ADD CONSTRAINT "Client_id_shopId_key" UNIQUE ("id", "shopId");
  END IF;
END $$;

ALTER TABLE "ClientDuplicateDismissal"
  ADD CONSTRAINT "ClientDuplicateDismissal_clientA_same_shop_fkey"
  FOREIGN KEY ("clientAId", "shopId") REFERENCES "Client"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDuplicateDismissal"
  ADD CONSTRAINT "ClientDuplicateDismissal_clientB_same_shop_fkey"
  FOREIGN KEY ("clientBId", "shopId") REFERENCES "Client"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

/* Tenant isolation, like every other shop table. */
GRANT SELECT, INSERT ON "ClientDuplicateDismissal" TO chairback_app;
REVOKE UPDATE, DELETE ON "ClientDuplicateDismissal" FROM chairback_app;
ALTER TABLE "ClientDuplicateDismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientDuplicateDismissal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ClientDuplicateDismissal";
CREATE POLICY tenant_isolation ON "ClientDuplicateDismissal"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
