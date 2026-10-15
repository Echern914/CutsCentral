/* WHO MARKED IT A NO-SHOW, AND WHO TOOK IT BACK.

   A barber marked a future appointment a no-show by mistake and could not
   undo it, and nothing recorded who had done it or when. This is the record:
   one row per staff status change of an appointment: "undo_no_show" in the
   same transaction that puts it back, "no_show" right after the mark commits
   (the mark runs inside the shared cancel engine). Additive only.

   Append-only and tenant-isolated exactly like AppointmentPriceChange
   (20260913000000_appointment_price_ledger). No FK to Appointment: the
   history outlives the row. */

CREATE TABLE "AppointmentStatusChange" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentStatusChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AppointmentStatusChange_shopId_appointmentId_createdAt_idx"
  ON "AppointmentStatusChange"("shopId", "appointmentId", "createdAt");
ALTER TABLE "AppointmentStatusChange"
  ADD CONSTRAINT "AppointmentStatusChange_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentStatusChange"
  ADD CONSTRAINT "AppointmentStatusChange_kind_check"
  CHECK ("kind" IN ('no_show', 'undo_no_show'));

CREATE OR REPLACE FUNCTION appointment_status_change_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'AppointmentStatusChange is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointment_status_change_no_update ON "AppointmentStatusChange";
CREATE TRIGGER appointment_status_change_no_update
  BEFORE UPDATE ON "AppointmentStatusChange"
  FOR EACH ROW EXECUTE FUNCTION appointment_status_change_immutable();

GRANT SELECT, INSERT ON "AppointmentStatusChange" TO chairback_app;
REVOKE UPDATE, DELETE ON "AppointmentStatusChange" FROM chairback_app;
ALTER TABLE "AppointmentStatusChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentStatusChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AppointmentStatusChange";
CREATE POLICY tenant_isolation ON "AppointmentStatusChange"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
