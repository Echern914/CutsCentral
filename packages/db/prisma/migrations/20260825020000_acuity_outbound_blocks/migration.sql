-- OUTBOUND Acuity mirror (incident 2026-08-25: Acuity sold 5:40-6:20pm over a
-- ChairBack booking at 6:10pm it had no way to see - sync had only ever run
-- INBOUND). Everything here is ADDITIVE and inert until a shop's
-- acuityOutboundMode leaves OFF: two nullable Staff columns, one mode column
-- defaulted OFF, one new table, one lease seed. No backfill, no rewrite of an
-- existing row, nothing that changes behavior for any shop on merge.

-- Which Acuity calendar is this chair. NULL = unmapped; the mirror refuses to
-- guess rather than block a colleague's calendar. mappedAt lets staleness be
-- DERIVED against AcuityConnection.connectedAt - a reconnect may be a whole
-- different Acuity account, where the same calendar id is someone else.
ALTER TABLE "Staff" ADD COLUMN "acuityCalendarId" TEXT;
ALTER TABLE "Staff" ADD COLUMN "acuityCalendarMappedAt" TIMESTAMP(3);

-- Per-shop rollout mode. A boolean could not express "rehearse first", and it
-- conflated CREATE with RELEASE: switching a shop off must never strand live
-- Acuity blocks, so the mode gates creation only - release and reconcile run
-- in every mode, OFF included.
CREATE TYPE "AcuityOutboundMode" AS ENUM ('OFF', 'OBSERVE', 'ENFORCE');
ALTER TABLE "Shop" ADD COLUMN "acuityOutboundMode" "AcuityOutboundMode" NOT NULL DEFAULT 'OFF';

CREATE TYPE "OutboundBlockState" AS ENUM (
  'PENDING', 'ACTIVE', 'UNKNOWN', 'FAILED', 'RELEASING', 'RELEASED'
);

CREATE TABLE "AcuityOutboundBlock" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "acuityBlockId" TEXT,
    "acuityCalendarId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "state" "OutboundBlockState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcuityOutboundBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcuityOutboundBlock_shopId_acuityBlockId_key"
  ON "AcuityOutboundBlock"("shopId", "acuityBlockId");
CREATE INDEX "AcuityOutboundBlock_shopId_state_idx"
  ON "AcuityOutboundBlock"("shopId", "state");
CREATE INDEX "AcuityOutboundBlock_appointmentId_idx"
  ON "AcuityOutboundBlock"("appointmentId");

-- THE idempotency backstop (requirement: at most one live block per
-- appointment, even under concurrent dispatch). Partial: RELEASING/RELEASED/
-- FAILED rows fall outside it, which is exactly what lets a reschedule hold
-- the old block in RELEASING while the replacement goes PENDING - the swap is
-- overlap-safe by construction, enforced in the database, not in code.
CREATE UNIQUE INDEX "AcuityOutboundBlock_live_per_appointment"
  ON "AcuityOutboundBlock"("appointmentId")
  WHERE "state" IN ('PENDING', 'ACTIVE', 'UNKNOWN');

ALTER TABLE "AcuityOutboundBlock" ADD CONSTRAINT "AcuityOutboundBlock_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcuityOutboundBlock" ADD CONSTRAINT "AcuityOutboundBlock_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcuityOutboundBlock" ADD CONSTRAINT "AcuityOutboundBlock_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as ExternalBlock.
GRANT SELECT, INSERT, UPDATE, DELETE ON "AcuityOutboundBlock" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AcuityOutboundBlock']
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

-- The reconciler cron is a no-op without its lease row (the exact failure that
-- shipped acuity-resync dead for a week - see engines/README on job_lease).
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('acuity-outbound-reconcile', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
