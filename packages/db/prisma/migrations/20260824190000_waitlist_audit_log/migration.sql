/* ------------------------------------------------------------------ */
/* Waitlist phase F1: an append-only audit trail                       */
/*                                                                     */
/* Ships BEFORE the automatic expiry worker on purpose. F2 is the first */
/* thing in this product that changes a customer's standing with no    */
/* human deciding to, and a bad sweep has to be reversible EXACTLY:    */
/*                                                                     */
/*   UPDATE "WaitlistEntry" SET "status" = 'WAITING'                   */
/*   WHERE "id" IN (SELECT "entryId" FROM "WaitlistEvent"              */
/*                  WHERE "type" = 'entry.expired_auto'                */
/*                    AND "createdAt" BETWEEN $1 AND $2);              */
/*                                                                     */
/* Without this table the best available handle is status='EXPIRED'    */
/* plus an updatedAt window, which also sweeps up every expiry a       */
/* barber set by hand in the same period.                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS "WaitlistEvent" (
    "id"            TEXT NOT NULL,
    "shopId"        TEXT NOT NULL,
    /* NOT a foreign key: history must outlive a deleted entry (the demo
       shop's nightly teardown deleteMany's them). Shop deletion still
       cascades via "shopId" below. */
    "entryId"       TEXT NOT NULL,
    "offerId"       TEXT,
    "appointmentId" TEXT,
    "type"          TEXT NOT NULL,
    "actorType"     TEXT NOT NULL,
    "actorUserId"   TEXT,
    "actorStaffId"  TEXT,
    "metadata"      JSONB,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEvent_pkey" PRIMARY KEY ("id")
);

/* Vocabulary pinned by CHECK, not an enum: an enum change rewrites the
   column type, a CHECK is additive. F2 (entry.expired_auto) and F3
   (entry.legacy_graced, entry.legacy_retained) are listed NOW so neither
   phase needs a migration that alters a constraint under live traffic. */
ALTER TABLE "WaitlistEvent" DROP CONSTRAINT IF EXISTS "WaitlistEvent_type_check";
ALTER TABLE "WaitlistEvent" ADD CONSTRAINT "WaitlistEvent_type_check"
  CHECK ("type" IN (
    'entry.joined',
    'entry.join_deduped',
    'entry.created_by_staff',
    'entry.cancelled_by_customer',
    'entry.status_changed',
    'entry.booked_linked',
    'entry.booked_externally',
    'entry.link_skipped',
    'entry.expired_auto',
    'entry.legacy_graced',
    'entry.legacy_retained',
    'offer.created',
    'offer.notified',
    'offer.unreachable',
    'offer.claimed',
    'offer.expired',
    'offer.released',
    'offer.advanced'
  ));
/* NOTE: the audit proposal also listed 'offer.no_candidates' (a scan that
   found nobody). It is deliberately NOT here: "entryId" is NOT NULL because
   that is what makes the per-entry timeline meaningful, and a scan that
   matched no one has no entry to hang off. Making the column nullable to fit
   one shop-level event would weaken the table for everything else. That
   outcome keeps its existing structured log line (code "exhausted", with
   scanned/pages) and, once offers exist, is derivable as a cancellation with
   no following offer.created. */

ALTER TABLE "WaitlistEvent" DROP CONSTRAINT IF EXISTS "WaitlistEvent_actorType_check";
ALTER TABLE "WaitlistEvent" ADD CONSTRAINT "WaitlistEvent_actorType_check"
  CHECK ("actorType" IN ('customer', 'staff', 'system'));

/* A customer acts on a bearer token and has no user id, by design. Anything
   claiming a staff actor must therefore name one - this stops a `staff`
   event being written with nobody attached, which would read as attributed
   while being worth nothing. */
ALTER TABLE "WaitlistEvent" DROP CONSTRAINT IF EXISTS "WaitlistEvent_staff_actor_identified_check";
ALTER TABLE "WaitlistEvent" ADD CONSTRAINT "WaitlistEvent_staff_actor_identified_check"
  CHECK ("actorType" <> 'staff' OR "actorUserId" IS NOT NULL OR "actorStaffId" IS NOT NULL);

/* The entry timeline (F4's eventual read) and the shop-wide sweep window
   that makes a bad automated run reversible. */
CREATE INDEX IF NOT EXISTS "WaitlistEvent_shopId_entryId_createdAt_idx"
  ON "WaitlistEvent"("shopId", "entryId", "createdAt");
CREATE INDEX IF NOT EXISTS "WaitlistEvent_shopId_createdAt_idx"
  ON "WaitlistEvent"("shopId", "createdAt");

ALTER TABLE "WaitlistEvent" DROP CONSTRAINT IF EXISTS "WaitlistEvent_shopId_fkey";
ALTER TABLE "WaitlistEvent" ADD CONSTRAINT "WaitlistEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* ------------------------------------------------------------------ */
/* Append-only: the trigger is the guarantee, the grant is hygiene     */
/*                                                                     */
/* 🔴 The obvious move - GRANT SELECT, INSERT and withhold UPDATE from  */
/*    chairback_app - is worth doing but constrains almost nothing on   */
/*    its own: only forShop()/runWithShop() SET ROLE to chairback_app.  */
/*    The public waitlist routes run as the CONNECTION OWNER with no    */
/*    role switch at all (see routes/shops.ts), and so does every       */
/*    engine and cron. A grant on a role those paths never assume is    */
/*    not an immutability guarantee.                                    */
/*                                                                      */
/*    The trigger binds every role, including the owner. That is what    */
/*    actually makes the table append-only.                             */
/*                                                                      */
/* 🔴 BEFORE UPDATE ONLY - deliberately not DELETE. A row-level DELETE   */
/*    trigger also fires for the "WaitlistEvent_shopId_fkey" cascade,    */
/*    which would make deleting a shop (teardown, and any data-deletion  */
/*    request) raise instead of succeed. Deletion stays governed by      */
/*    cascade and retention; MUTATION is what must be unforgeable.       */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION waitlist_event_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'WaitlistEvent is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS waitlist_event_no_update ON "WaitlistEvent";
CREATE TRIGGER waitlist_event_no_update
  BEFORE UPDATE ON "WaitlistEvent"
  FOR EACH ROW EXECUTE FUNCTION waitlist_event_immutable();

/* ------------------------------------------------------------------ */
/* RLS: the same tenant isolation every other shop table carries       */
/* ------------------------------------------------------------------ */

/* 🔴 REVOKE, not just GRANT. 20260607000000_rls_defense_in_depth set
   ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE, so
   chairback_app is handed all four on every NEW table automatically. A bare
   "GRANT SELECT, INSERT" here would be a no-op that reads like a restriction -
   verified against chairback_test, where the role had UPDATE and DELETE on
   this table before the revoke below existed. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chairback_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON "WaitlistEvent" TO chairback_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON "WaitlistEvent" FROM chairback_app';
  END IF;
END
$$;

ALTER TABLE "WaitlistEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "WaitlistEvent";
CREATE POLICY tenant_isolation ON "WaitlistEvent"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
