/* ------------------------------------------------------------------ */
/* Waitlist phase F2: the automatic entry-expiry sweep                 */
/*                                                                     */
/* Two things the worker cannot run without: an index it can scan      */
/* across shops, and a lease row.                                      */
/* ------------------------------------------------------------------ */

/* 🔴 EVERY existing WaitlistEntry index is shopId-first:
     (shopId, status, createdAt) and (shopId, status, expiresAt).
   The sweep is CROSS-SHOP - it walks every tenant's active entries in
   one keyset order - so none of them can serve it, and without this the
   scan degrades to a full table read every hour.

   Partial, on the two statuses the sweep touches, in exactly its scan
   order (createdAt, id). Same shape as
   Appointment_staff_start_active_uq, which is also partial on status.

   Plain (non-CONCURRENT) build, following the reasoning already written
   down in 20260706160000_scale_indexes: these tables are small, so the
   build locks only momentarily - and CREATE INDEX CONCURRENTLY cannot
   run inside the transaction Prisma wraps a migration in. */
CREATE INDEX IF NOT EXISTS "WaitlistEntry_active_sweep_idx"
  ON "WaitlistEntry" ("createdAt", "id")
  WHERE "status" IN ('WAITING', 'CONTACTED');

/* withLease() acquires by UPDATE-ing an existing row, so a job whose
   name was never seeded NEVER runs: the conditional UPDATE matches 0
   rows forever and the job is silently dead - exactly how acuity-resync
   shipped in #99. scheduler.leaseSeed.test.ts enforces this file's
   existence structurally, and was confirmed RED for
   'waitlist-entry-expiry' before this statement was written.

   expiresAt = now() is already in the past by the first tick, so the
   first acquire wins. Idempotent via ON CONFLICT; matches
   20260823200000_waitlist_offer_expiry_lease_seed.

   Seeding the lease does NOT enable the sweep: the worker writes
   nothing unless WAITLIST_ENTRY_EXPIRY_ENABLED is true, and it is
   false by default. This migration is safe to deploy on its own. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('waitlist-entry-expiry', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
