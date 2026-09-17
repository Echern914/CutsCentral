-- Booking integrity P0: durable conflict records + receipt idempotency.
--
-- EXPAND ONLY. Every statement here is additive and backward compatible: a
-- running old API neither reads nor writes any of it, so this deploys safely
-- BEFORE the code that uses it. There is no contract step in this migration -
-- nothing is dropped, narrowed or made NOT NULL.

-- 1. The receipt's client-generated operation id. NULLABLE on purpose: every
--    existing row, and every write that is not a receipt, carries NULL.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "operationId" TEXT;

-- The idempotency boundary is the TENANT, not the barber and not the clock: a
-- retry of one submission collapses, while two genuine cuts seconds apart keep
-- their own ids and both land.
--
-- 🔴 PARTIAL, so the 273 existing appointments (all NULL) do not collide with
-- each other. Without the WHERE clause this index cannot be created at all.
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_shop_operation_key"
  ON "Appointment" ("shopId", "operationId")
  WHERE "operationId" IS NOT NULL;

-- 2. A double-booked chair is a safety alert, so it defaults ON - including for
--    shops that have already silenced the other kinds.
ALTER TABLE "BarberNotifyPref"
  ADD COLUMN IF NOT EXISTS "conflictEnabled" BOOLEAN NOT NULL DEFAULT true;

-- 3. The conflict itself, so it outlives a log line.
CREATE TABLE IF NOT EXISTS "BookingConflict" (
  "id"               TEXT NOT NULL,
  "shopId"           TEXT NOT NULL,
  "staffId"          TEXT NOT NULL,
  "receiptId"        TEXT NOT NULL,
  "conflictingId"    TEXT NOT NULL,
  "conflictingKind"  TEXT NOT NULL,
  "overlapStart"     TIMESTAMP(3) NOT NULL,
  "overlapEnd"       TIMESTAMP(3) NOT NULL,
  "source"           TEXT NOT NULL,
  "detectedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"       TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  CONSTRAINT "BookingConflict_pkey" PRIMARY KEY ("id")
);

-- 🔴 THIS INDEX IS THE DEDUPLICATION. One row per (receipt, conflicting
-- record) pair, scoped to the tenant - so repeated detection from a retry, a
-- re-sync or a second sweep writes nothing and alerts nobody twice.
CREATE UNIQUE INDEX IF NOT EXISTS "BookingConflict_shop_receipt_other_key"
  ON "BookingConflict" ("shopId", "receiptId", "conflictingId");

-- The manager's list: open conflicts for a shop, newest first.
CREATE INDEX IF NOT EXISTS "BookingConflict_shop_open_idx"
  ON "BookingConflict" ("shopId", "resolvedAt", "detectedAt");

ALTER TABLE "BookingConflict"
  DROP CONSTRAINT IF EXISTS "BookingConflict_shopId_fkey";
ALTER TABLE "BookingConflict"
  ADD CONSTRAINT "BookingConflict_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* The conflict is the shop's: tenant isolation, like every other shop table.
   GRANT then FORCE + policy - the app role can only ever see its own rows. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "BookingConflict" TO chairback_app;
ALTER TABLE "BookingConflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingConflict" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BookingConflict";
CREATE POLICY tenant_isolation ON "BookingConflict"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
