-- Apple Wallet APPOINTMENT pass: one row per iOS device registered for
-- auto-updates of one appointment's pass (PassKit Web Service protocol) - the
-- punch card's twin table, keyed on the APPOINTMENT rather than the client.
-- pushToken is the PASS-update APNs token on the appointment pass type's
-- topic, not the app push token. Additive only - nothing existing changes,
-- and the whole feature is dark until the WALLET_APPT_* env vars are set.

-- CreateTable
CREATE TABLE "WalletAppointmentPassRegistration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "deviceLibraryIdentifier" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAppointmentPassRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (a device registers a given pass once; re-registering refreshes)
CREATE UNIQUE INDEX "WalletAppointmentPassRegistration_deviceLibraryIdentifie_key"
  ON "WalletAppointmentPassRegistration"("deviceLibraryIdentifier", "appointmentId");

-- CreateIndex (the poke path: all devices holding this appointment's pass)
CREATE INDEX "WalletAppointmentPassRegistration_appointmentId_idx"
  ON "WalletAppointmentPassRegistration"("appointmentId");

-- CreateIndex
CREATE INDEX "WalletAppointmentPassRegistration_shopId_idx"
  ON "WalletAppointmentPassRegistration"("shopId");

-- AddForeignKey
ALTER TABLE "WalletAppointmentPassRegistration"
  ADD CONSTRAINT "WalletAppointmentPassRegistration_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAppointmentPassRegistration"
  ADD CONSTRAINT "WalletAppointmentPassRegistration_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as WalletPassRegistration.
-- The public wallet web-service routes write via runAsOwner (device auth = the
-- pass's authenticationToken HMAC), exactly like the punch-card registrations.
GRANT SELECT, INSERT, UPDATE, DELETE ON "WalletAppointmentPassRegistration" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['WalletAppointmentPassRegistration']
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
