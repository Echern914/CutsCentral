-- SQUARE OUTBOUND MIRRORING (S2)
--
-- The durable half: one row per mirrored Square booking, and a webhook inbox
-- keyed on Square's event_id.
--
-- Idempotent throughout (IF NOT EXISTS / DROP POLICY IF EXISTS) so the deploy
-- gate re-applying migrations on every boot is a no-op rather than an error.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SquareOutboundState') THEN
    CREATE TYPE "SquareOutboundState" AS ENUM
      ('PENDING', 'ACTIVE', 'UNKNOWN', 'FAILED', 'RELEASING', 'RELEASED');
  END IF;
END
$$;

--  One mirrored Square booking

CREATE TABLE IF NOT EXISTS "SquareOutboundBooking" (
  "id"                            TEXT NOT NULL,
  "shopId"                        TEXT NOT NULL,
  "appointmentId"                 TEXT NOT NULL,
  "staffId"                       TEXT NOT NULL,
  "serviceId"                     TEXT NOT NULL,
  "squareBookingId"               TEXT,
  "squareBookingVersion"          INTEGER,
  "squareBookingStatus"           TEXT,
  "squareLocationId"              TEXT NOT NULL,
  "squareTeamMemberId"            TEXT NOT NULL,
  "squareServiceVariationId"      TEXT NOT NULL,
  "squareServiceVariationVersion" TEXT,
  "squareCustomerId"              TEXT,
  "startsAt"                      TIMESTAMP(3) NOT NULL,
  "endsAt"                        TIMESTAMP(3) NOT NULL,
  "idempotencyKey"                TEXT NOT NULL,
  "state"                         "SquareOutboundState" NOT NULL DEFAULT 'PENDING',
  "attempts"                      INTEGER NOT NULL DEFAULT 0,
  "lastError"                     TEXT,
  "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SquareOutboundBooking_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SquareOutboundBooking_shopId_fkey') THEN
    ALTER TABLE "SquareOutboundBooking"
      ADD CONSTRAINT "SquareOutboundBooking_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SquareOutboundBooking_appointmentId_fkey') THEN
    -- Cascade: a hard-deleted appointment must not leave a mirror row that
    -- blocks reconciliation forever. (The normal lifecycle cancels rather than
    -- deletes, so this is belt-and-braces.)
    ALTER TABLE "SquareOutboundBooking"
      ADD CONSTRAINT "SquareOutboundBooking_appointmentId_fkey"
      FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SquareOutboundBooking_staffId_fkey') THEN
    -- Restrict: deleting a barber who still has live Square bookings would
    -- strand them on the seller's calendar with nothing left pointing at them.
    ALTER TABLE "SquareOutboundBooking"
      ADD CONSTRAINT "SquareOutboundBooking_staffId_fkey"
      FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SquareOutboundBooking_serviceId_fkey') THEN
    ALTER TABLE "SquareOutboundBooking"
      ADD CONSTRAINT "SquareOutboundBooking_serviceId_fkey"
      FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- The idempotency key is minted once and replayed on retry; two rows sharing
-- one key would mean two bookings for one appointment the moment Square
-- honoured it.
CREATE UNIQUE INDEX IF NOT EXISTS "SquareOutboundBooking_idempotencyKey_key"
  ON "SquareOutboundBooking"("idempotencyKey");

-- A given Square booking belongs to exactly one row (idempotent re-dispatch).
CREATE UNIQUE INDEX IF NOT EXISTS "SquareOutboundBooking_shopId_squareBookingId_key"
  ON "SquareOutboundBooking"("shopId", "squareBookingId");

-- 🔴 THE REAL IDEMPOTENCY GUARANTEE: at most ONE live mirror per appointment.
--
-- The read-then-write pre-check in the engine is a fast path that two
-- concurrent writers both pass. This index is what actually holds, and the
-- P2002 branch that catches it is exercised by disabling the pre-check.
-- Partial, because RELEASED and FAILED rows are history: an appointment
-- rescheduled three times legitimately has three dead rows and one live one.
CREATE UNIQUE INDEX IF NOT EXISTS "SquareOutboundBooking_live_per_appointment"
  ON "SquareOutboundBooking"("appointmentId")
  WHERE "state" IN ('PENDING', 'ACTIVE', 'UNKNOWN');

-- The reconciler's work queue.
CREATE INDEX IF NOT EXISTS "SquareOutboundBooking_shopId_state_idx"
  ON "SquareOutboundBooking"("shopId", "state");
CREATE INDEX IF NOT EXISTS "SquareOutboundBooking_appointmentId_idx"
  ON "SquareOutboundBooking"("appointmentId");

-- Tenant RLS, identical to AcuityOutboundBlock: ENABLE + FORCE + a policy keyed
-- on current_shop_id(). The app connects as a superuser and therefore bypasses
-- RLS in practice; what this closes is the Supabase data API and any future
-- non-superuser role. See squareConnectionRls.test.ts, which measures exactly
-- what FORCE does and does not buy.
ALTER TABLE "SquareOutboundBooking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SquareOutboundBooking" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "SquareOutboundBooking";
CREATE POLICY tenant_isolation ON "SquareOutboundBooking"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

--  The webhook inbox

CREATE TABLE IF NOT EXISTS "SquareWebhookEvent" (
  "id"          TEXT NOT NULL,
  "eventId"     TEXT NOT NULL,
  "merchantId"  TEXT,
  "type"        TEXT,
  "shopId"      TEXT,
  "bookingId"   TEXT,
  "status"      TEXT NOT NULL DEFAULT 'RECEIVED',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "SquareWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- 🔴 The whole point of the table. A duplicate delivery must collide here and
-- cost one failed INSERT, rather than replaying every side effect behind it.
CREATE UNIQUE INDEX IF NOT EXISTS "SquareWebhookEvent_eventId_key"
  ON "SquareWebhookEvent"("eventId");
CREATE INDEX IF NOT EXISTS "SquareWebhookEvent_status_receivedAt_idx"
  ON "SquareWebhookEvent"("status", "receivedAt");
CREATE INDEX IF NOT EXISTS "SquareWebhookEvent_merchantId_idx"
  ON "SquareWebhookEvent"("merchantId");

-- NOT a tenant table, deliberately. The row is written BEFORE the merchant is
-- resolved to a shop, and an event from an unknown or revoked merchant has no
-- shop at all - a shopId-keyed policy would reject exactly the rows most worth
-- keeping. Same posture as SquareConnection: ENABLE (closes the Supabase data
-- API), no FORCE, no policy.
ALTER TABLE "SquareWebhookEvent" ENABLE ROW LEVEL SECURITY;

-- chairback_app has no business in either table: outbound dispatch and webhook
-- intake both run as the connection owner, outside any tenant transaction.
-- REVOKE rather than "don't GRANT" - 20260607000000 set ALTER DEFAULT
-- PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE, so every new table hands
-- the role all four automatically and a bare GRANT here would read like a
-- restriction while changing nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chairback_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "SquareWebhookEvent" FROM chairback_app';
  END IF;
END
$$;
