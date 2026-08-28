/* ------------------------------------------------------------------ */
/* WALK-IN MODE PR 1: the same-day kiosk queue domain.                 */
/*                                                                     */
/* 🔴 NOT the waitlist. WaitlistEntry = "tell me when a FUTURE slot    */
/* opens"; WalkInEntry = "I am HERE, waiting to be served." Separate   */
/* tables, separate lifecycle, separate API - shared conventions only. */
/*                                                                     */
/* Everything here is additive and lands DARK: the API surface behind  */
/* it is gated by WALK_IN_MODE_ENABLED (env, default false) and        */
/* Shop.walkInEnabled (default false). No behavior changes for any     */
/* existing shop.                                                      */
/* ------------------------------------------------------------------ */

/* Shop switches + the kiosk URL credential (hash only; the raw token
   exists in the settings response the moment it is minted, PR 2). */
ALTER TABLE "Shop" ADD COLUMN "walkInEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "walkInAcceptingNow" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "walkInKioskTokenHash" TEXT;

CREATE UNIQUE INDEX "Shop_walkInKioskTokenHash_key" ON "Shop"("walkInKioskTokenHash");

/* ------------------------------------------------------------------ */
/* WalkInEntry - one person standing in one shop's line               */
/* ------------------------------------------------------------------ */

CREATE TABLE "WalkInEntry" (
    "id"                  TEXT NOT NULL,
    "shopId"              TEXT NOT NULL,
    "clientId"            TEXT,
    "firstName"           TEXT NOT NULL,
    "lastName"            TEXT,
    "phone"               TEXT,
    "source"              TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'WAITING',
    "position"            INTEGER NOT NULL,
    "preferredStaffId"    TEXT,
    "assignedStaffId"     TEXT,
    "quotedWaitMin"       INTEGER,
    "quotedAt"            TIMESTAMP(3),
    "note"                TEXT,
    "trackTokenHash"      TEXT,
    "trackTokenExpiresAt" TIMESTAMP(3),
    "trackTokenRevokedAt" TIMESTAMP(3),
    "appointmentId"       TEXT,
    "smsConsentAt"        TIMESTAMP(3),
    "smsConsentSource"    TEXT,
    "smsConsentVersion"   TEXT,
    "smsConsentPhone"     TEXT,
    "joinedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt"          TIMESTAMP(3),
    "readyAt"             TIMESTAMP(3),
    "startedAt"           TIMESTAMP(3),
    "completedAt"         TIMESTAMP(3),
    "leftAt"              TIMESTAMP(3),
    "noShowAt"            TIMESTAMP(3),
    "canceledAt"          TIMESTAMP(3),
    "expiredAt"           TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalkInEntry_pkey" PRIMARY KEY ("id")
);

/* Vocabulary pinned by CHECK, not an enum: an enum change rewrites the
   column type, a CHECK is additive. The full 9-state lifecycle is pinned
   now so no later phase alters a constraint under live traffic.
   engines/walkInLifecycle.ts owns which transitions BETWEEN these states
   are legal; a test asserts its ACTIVE_STATUSES list appears verbatim in
   this file so code and index predicate cannot drift. */
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_status_check"
  CHECK ("status" IN ('WAITING','ASSIGNED','READY','IN_SERVICE',
                      'COMPLETED','LEFT','NO_SHOW','CANCELED','EXPIRED'));

ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_source_check"
  CHECK ("source" IN ('KIOSK','STAFF'));

/* 🔑 One live spot in the line per phone number. Partial over the ACTIVE
   statuses only (the WaitlistEntry dedupe shape): a terminal entry frees
   the number, so leaving and rejoining tomorrow - or later today - works.
   Rows with no phone (staff-created) are unbound; nulls are distinct.
   The kiosk (PR 2) catches this as P2002 and answers with the SAME body
   as a fresh join - the constraint is the guarantee, the constant
   response is the privacy. */
CREATE UNIQUE INDEX "WalkInEntry_one_active_per_phone"
  ON "WalkInEntry"("shopId", "phone")
  WHERE "status" IN ('WAITING','ASSIGNED','READY','IN_SERVICE')
    AND "phone" IS NOT NULL;

CREATE UNIQUE INDEX "WalkInEntry_trackTokenHash_key" ON "WalkInEntry"("trackTokenHash");
CREATE UNIQUE INDEX "WalkInEntry_appointmentId_key" ON "WalkInEntry"("appointmentId");

/* The board read; the expiry sweep's keyset scan; the per-client lookup;
   a barber's own-chair reads. */
CREATE INDEX "WalkInEntry_shopId_status_position_idx"
  ON "WalkInEntry"("shopId", "status", "position");
CREATE INDEX "WalkInEntry_shopId_status_joinedAt_id_idx"
  ON "WalkInEntry"("shopId", "status", "joinedAt", "id");
CREATE INDEX "WalkInEntry_shopId_clientId_idx"
  ON "WalkInEntry"("shopId", "clientId");
CREATE INDEX "WalkInEntry_shopId_assignedStaffId_status_idx"
  ON "WalkInEntry"("shopId", "assignedStaffId", "status");

ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_preferredStaffId_fkey"
  FOREIGN KEY ("preferredStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_assignedStaffId_fkey"
  FOREIGN KEY ("assignedStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/* ------------------------------------------------------------------ */
/* WalkInEntryService - the selected services, snapshotted at join     */
/* ------------------------------------------------------------------ */

CREATE TABLE "WalkInEntryService" (
    "id"                TEXT NOT NULL,
    "shopId"            TEXT NOT NULL,
    "entryId"           TEXT NOT NULL,
    "serviceId"         TEXT NOT NULL,
    "nameAtJoin"        TEXT NOT NULL,
    "durationMinAtJoin" INTEGER NOT NULL,
    "priceAtJoin"       DECIMAL(10,2),
    "sortOrder"         INTEGER NOT NULL DEFAULT 0,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalkInEntryService_pkey" PRIMARY KEY ("id")
);

/* A zero/negative snapshot duration would silently zero out the wait
   estimate; refuse it at the door. */
ALTER TABLE "WalkInEntryService" ADD CONSTRAINT "WalkInEntryService_duration_check"
  CHECK ("durationMinAtJoin" > 0);

CREATE UNIQUE INDEX "WalkInEntryService_entryId_serviceId_key"
  ON "WalkInEntryService"("entryId", "serviceId");
CREATE INDEX "WalkInEntryService_shopId_entryId_idx"
  ON "WalkInEntryService"("shopId", "entryId");

ALTER TABLE "WalkInEntryService" ADD CONSTRAINT "WalkInEntryService_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalkInEntryService" ADD CONSTRAINT "WalkInEntryService_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "WalkInEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
/* Restrict, not SetNull: a service with live queue selections refuses
   deletion the same way it refuses while appointments reference it. */
ALTER TABLE "WalkInEntryService" ADD CONSTRAINT "WalkInEntryService_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/* ------------------------------------------------------------------ */
/* WalkInEvent - append-only audit of every lifecycle mutation         */
/* (same construction and reasoning as WaitlistEvent, 20260824190000)  */
/* ------------------------------------------------------------------ */

CREATE TABLE "WalkInEvent" (
    "id"            TEXT NOT NULL,
    "shopId"        TEXT NOT NULL,
    /* NOT a foreign key: history must outlive a deleted entry (demo
       teardown deleteMany's them). Shop deletion still cascades via
       "shopId" below. */
    "entryId"       TEXT NOT NULL,
    "appointmentId" TEXT,
    "type"          TEXT NOT NULL,
    "actorType"     TEXT NOT NULL,
    "actorUserId"   TEXT,
    "actorStaffId"  TEXT,
    "metadata"      JSONB,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalkInEvent_pkey" PRIMARY KEY ("id")
);

/* The FULL vocabulary, PR 2-4 types included, pinned NOW so no later
   phase needs a migration that alters a constraint under live traffic:
   check_in/dedupe/link types land with the kiosk (PR 2), service_started/
   completed with the start path (PR 3), expired_auto with the sweep (PR 4).
   Kiosk-token rotation is a SHOP-level event with no entry and is
   deliberately NOT here ("entryId" is NOT NULL because that is what makes
   the per-entry timeline meaningful - the offer.no_candidates lesson);
   it keeps a structured log line instead. */
ALTER TABLE "WalkInEvent" ADD CONSTRAINT "WalkInEvent_type_check"
  CHECK ("type" IN (
    'entry.checked_in',
    'entry.created_by_staff',
    'entry.check_in_deduped',
    'entry.claimed',
    'entry.assigned',
    'entry.ready',
    'entry.returned',
    'entry.reordered',
    'entry.edited',
    'entry.service_started',
    'entry.completed',
    'entry.left',
    'entry.no_show',
    'entry.canceled',
    'entry.expired_auto',
    'entry.link_sent',
    'entry.link_regenerated'
  ));

ALTER TABLE "WalkInEvent" ADD CONSTRAINT "WalkInEvent_actorType_check"
  CHECK ("actorType" IN ('customer', 'staff', 'system'));

/* A customer acts on a bearer token and has no user id, by design. Anything
   claiming a staff actor must therefore name one - this stops a `staff`
   event being written with nobody attached, which would read as attributed
   while being worth nothing. */
ALTER TABLE "WalkInEvent" ADD CONSTRAINT "WalkInEvent_staff_actor_identified_check"
  CHECK ("actorType" <> 'staff' OR "actorUserId" IS NOT NULL OR "actorStaffId" IS NOT NULL);

/* The entry timeline, and the shop-wide window that makes a bad automated
   sweep reversible (the same repair query shape as WaitlistEvent's header). */
CREATE INDEX "WalkInEvent_shopId_entryId_createdAt_idx"
  ON "WalkInEvent"("shopId", "entryId", "createdAt");
CREATE INDEX "WalkInEvent_shopId_createdAt_idx"
  ON "WalkInEvent"("shopId", "createdAt");

ALTER TABLE "WalkInEvent" ADD CONSTRAINT "WalkInEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* ------------------------------------------------------------------ */
/* Append-only: the trigger is the guarantee, the grant is hygiene     */
/* (verbatim reasoning in 20260824190000_waitlist_audit_log: the GRANT */
/* binds only chairback_app, but engines and public routes run as the  */
/* CONNECTION OWNER - only a trigger binds every role. BEFORE UPDATE   */
/* only, deliberately not DELETE: a row-level DELETE trigger also      */
/* fires for the shopId FK cascade, which would make deleting a shop   */
/* raise instead of succeed.)                                          */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION walk_in_event_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'WalkInEvent is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS walk_in_event_no_update ON "WalkInEvent";
CREATE TRIGGER walk_in_event_no_update
  BEFORE UPDATE ON "WalkInEvent"
  FOR EACH ROW EXECUTE FUNCTION walk_in_event_immutable();

/* ------------------------------------------------------------------ */
/* RLS: the same tenant isolation every other shop table carries       */
/* ------------------------------------------------------------------ */

/* 🔴 REVOKE, not just GRANT, on the audit table.
   20260607000000_rls_defense_in_depth set ALTER DEFAULT PRIVILEGES ...
   GRANT SELECT, INSERT, UPDATE, DELETE, so chairback_app is handed all
   four on every NEW table automatically. A bare "GRANT SELECT, INSERT"
   would be a no-op that reads like a restriction. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chairback_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "WalkInEntry" TO chairback_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "WalkInEntryService" TO chairback_app';
    EXECUTE 'GRANT SELECT, INSERT ON "WalkInEvent" TO chairback_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON "WalkInEvent" FROM chairback_app';
  END IF;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['WalkInEntry','WalkInEntryService','WalkInEvent'] LOOP
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
