-- Availability generation + external-block override audit (PR #402). Additive
-- only: one Shop column with a default, one new append-only tenant table.
-- Nothing is rewritten, nothing is dropped, no existing row changes value.

-- Shop: the per-shop availability generation. Advanced atomically after every
-- availability-changing commit; every cached availability answer is keyed on
-- it and served only while it still matches. See services/availabilityCache.ts.
ALTER TABLE "Shop" ADD COLUMN "availabilityGeneration" INTEGER NOT NULL DEFAULT 0;

-- A barber's deliberate booking over an externally blocked span. Append-only.
CREATE TABLE "AppointmentOverride" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "blockedFrom" TIMESTAMP(3) NOT NULL,
    "blockedTo" TIMESTAMP(3) NOT NULL,
    "blockReason" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentOverride_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AppointmentOverride_shopId_appointmentId_createdAt_idx"
  ON "AppointmentOverride"("shopId", "appointmentId", "createdAt");
CREATE INDEX "AppointmentOverride_shopId_createdAt_idx"
  ON "AppointmentOverride"("shopId", "createdAt");
ALTER TABLE "AppointmentOverride"
  ADD CONSTRAINT "AppointmentOverride_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* The kinds and sources are a closed set; a typo is refused, not recorded. */
ALTER TABLE "AppointmentOverride"
  ADD CONSTRAINT "AppointmentOverride_kind_check"
  CHECK ("kind" IN ('external_block'));
ALTER TABLE "AppointmentOverride"
  ADD CONSTRAINT "AppointmentOverride_source_check"
  CHECK ("source" IN ('dashboard_create', 'dashboard_reschedule', 'dashboard_edit'));
ALTER TABLE "AppointmentOverride"
  ADD CONSTRAINT "AppointmentOverride_span_check"
  CHECK ("blockedTo" > "blockedFrom");

/* Append-only for EVERYONE, the connection owner included - the same trigger
   shape as AppointmentPriceChange. A grant is not immutability; the trigger is.
   DELETE deliberately still works (a shop cascade must succeed). */
CREATE OR REPLACE FUNCTION appointment_override_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'AppointmentOverride is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointment_override_no_update ON "AppointmentOverride";
CREATE TRIGGER appointment_override_no_update
  BEFORE UPDATE ON "AppointmentOverride"
  FOR EACH ROW EXECUTE FUNCTION appointment_override_immutable();

/* Tenant isolation, like every other shop table. */
GRANT SELECT, INSERT ON "AppointmentOverride" TO chairback_app;
REVOKE UPDATE, DELETE ON "AppointmentOverride" FROM chairback_app;
ALTER TABLE "AppointmentOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentOverride" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AppointmentOverride";
CREATE POLICY tenant_isolation ON "AppointmentOverride"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
