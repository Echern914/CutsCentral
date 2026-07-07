-- Recurring appointments: a RecurringSeries holds the "every N weeks" rule
-- (stored shop-local so DST is handled by recomputing each occurrence's instant),
-- and each concrete occurrence is a normal Appointment row linked by seriesId.
-- Materializing occurrences as real rows keeps reminders / promotion / loyalty /
-- slot-opened working unchanged; the series row only groups them for cancel.

-- CreateEnum
CREATE TYPE "RecurringSeriesStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELED');

-- CreateTable
CREATE TABLE "RecurringSeries" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "clientId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "weekday" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "count" INTEGER,
    "untilDate" TIMESTAMP(3),
    "status" "RecurringSeriesStatus" NOT NULL DEFAULT 'ACTIVE',
    "manageToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringSeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringSeries_manageToken_key" ON "RecurringSeries"("manageToken");
CREATE INDEX "RecurringSeries_shopId_status_idx" ON "RecurringSeries"("shopId", "status");
CREATE INDEX "RecurringSeries_shopId_staffId_idx" ON "RecurringSeries"("shopId", "staffId");

-- AddForeignKey (series -> shop/staff/service/client). Restrict on staff/service
-- so a provider/service backing an active series can't be silently deleted;
-- SetNull on client mirrors Appointment (survives archive/merge).
ALTER TABLE "RecurringSeries" ADD CONSTRAINT "RecurringSeries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringSeries" ADD CONSTRAINT "RecurringSeries_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringSeries" ADD CONSTRAINT "RecurringSeries_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringSeries" ADD CONSTRAINT "RecurringSeries_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: link occurrences back to their series. SetNull (NOT Cascade) is
-- load-bearing: canceling/deleting a series must never delete an already-
-- COMPLETED occurrence whose Visit/PunchLedger already granted punches.
ALTER TABLE "Appointment" ADD COLUMN "seriesId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "seriesOccurrenceIndex" INTEGER;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "RecurringSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Appointment_seriesId_idx" ON "Appointment"("seriesId");

-- RLS defense-in-depth: same tenant-isolation pattern as WaitlistEntry and the
-- other tenant tables. The dashboard path (forShop -> SET ROLE chairback_app) is
-- enforced; the public first-booking path runs as the connection owner (no SET
-- ROLE) inside the same tx and bypasses FORCE RLS, like the other public writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "RecurringSeries" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['RecurringSeries']
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
