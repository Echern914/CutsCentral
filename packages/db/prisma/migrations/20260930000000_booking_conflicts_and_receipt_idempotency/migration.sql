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
-- WHY PARTIAL. Not because a plain unique index would fail: PostgreSQL treats
-- NULLs as DISTINCT in a unique index, so all 274 existing (NULL) rows would
-- coexist under a plain one perfectly well. Measured, not assumed - PG 17.10
-- accepted exactly that index over 350 NULL rows, and a 351st still inserted.
-- An earlier comment here claimed the opposite; it was wrong.
--
-- The partial predicate is still the right shape, for reasons that ARE true:
--   * it indexes only rows that can participate in idempotency, so the index
--     holds the receipts rather than every appointment ever booked;
--   * it states the scope in the schema - "this constraint is about rows that
--     carry an operation id" - instead of leaving it implied by NULL semantics;
--   * it does not depend on NULLs-are-distinct staying the default. That is a
--     per-index choice since PG 15 (NULLS NOT DISTINCT), and a constraint whose
--     correctness rests on an unstated default is one setting away from
--     rejecting every legacy row.
-- Pinned by migrationNullSemantics.test.ts, which asserts all three behaviours
-- against the real engine rather than trusting this comment.
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_shop_operation_key"
  ON "Appointment" ("shopId", "operationId")
  WHERE "operationId" IS NOT NULL;

-- 2. The conflict itself, so it outlives a log line.
--
-- NOTE: there is deliberately NO BarberNotifyPref.conflictEnabled column. An
-- earlier draft added one defaulting to true, but nothing could ever write it -
-- no route, no settings toggle - so it was a preference in name only. A
-- double-booked chair is an integrity alert rather than a communication
-- preference, so the kind is mandatory in code (services/barberNotify.ts) and
-- the schema says nothing it cannot honour.
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
--
-- 🔴 conflictingKind IS PART OF THE IDENTITY, not decoration. The id alone does
-- not identify a row: `conflictingId` is a cuid drawn from THREE independent
-- tables (Appointment, Visit, ExternalBlock), and nothing in this database
-- makes those id spaces disjoint - no shared sequence, no shared domain, no
-- cross-table constraint. Uniqueness here would then rest on cuid collisions
-- being unlikely, and "unlikely" is not a key. The pair (kind, id) is what
-- actually names a record, so that is what the constraint uses; the cost is one
-- more text column in an index nobody joins on.
CREATE UNIQUE INDEX IF NOT EXISTS "BookingConflict_shop_receipt_other_key"
  ON "BookingConflict" ("shopId", "receiptId", "conflictingKind", "conflictingId");

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
