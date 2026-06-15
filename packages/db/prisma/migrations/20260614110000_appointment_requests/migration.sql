-- Appointment requests: leads from the public shop page's "Request an
-- appointment" form (for barbers with no online booking). Plus two Shop columns:
-- takesRequests (show the form) and notifyPhone (barber's number, texted on each
-- new lead; null = inbox only).

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "takesRequests" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "notifyPhone" TEXT;

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "message" TEXT,
    "preferredTime" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentRequest_shopId_status_idx" ON "AppointmentRequest"("shopId", "status");

-- CreateIndex
CREATE INDEX "AppointmentRequest_shopId_createdAt_idx" ON "AppointmentRequest"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other tenant tables.
-- The dashboard path (forShop -> SET ROLE chairback_app) is enforced; the public
-- lead-insert runs as the connection owner (no SET ROLE) and bypasses FORCE RLS,
-- exactly like the public rewards/Twilio writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "AppointmentRequest" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AppointmentRequest']
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
