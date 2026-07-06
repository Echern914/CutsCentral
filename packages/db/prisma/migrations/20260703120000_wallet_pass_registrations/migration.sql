-- Apple Wallet punch card: one row per iOS device registered for auto-updates
-- of one client's pass (Apple's PassKit Web Service protocol). pushToken is
-- the PASS-update APNs token (pass-certificate topic), not the app push token.
-- Additive only - nothing existing changes.

-- CreateTable
CREATE TABLE "WalletPassRegistration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "deviceLibraryIdentifier" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletPassRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (a device registers a given pass once; re-registering refreshes)
CREATE UNIQUE INDEX "WalletPassRegistration_deviceLibraryIdentifier_clientId_key"
  ON "WalletPassRegistration"("deviceLibraryIdentifier", "clientId");

-- CreateIndex (the poke path: all devices holding this client's pass)
CREATE INDEX "WalletPassRegistration_clientId_idx" ON "WalletPassRegistration"("clientId");

-- CreateIndex
CREATE INDEX "WalletPassRegistration_shopId_idx" ON "WalletPassRegistration"("shopId");

-- AddForeignKey
ALTER TABLE "WalletPassRegistration" ADD CONSTRAINT "WalletPassRegistration_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletPassRegistration" ADD CONSTRAINT "WalletPassRegistration_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as PushSubscription. The
-- public wallet web-service routes write via runAsOwner (device auth = the
-- pass's authenticationToken HMAC), exactly like the rewards push-native writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "WalletPassRegistration" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['WalletPassRegistration']
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
