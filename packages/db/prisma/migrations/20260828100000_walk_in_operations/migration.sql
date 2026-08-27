/* ------------------------------------------------------------------ */
/* WALK-IN MODE PR 4: operations - notification stamps, the end-of-day */
/* expiry sweep's index + lease, all additive and still dark.          */
/* ------------------------------------------------------------------ */

/* Notification idempotency stamps (the Appointment convention: one column
   per send, claimed by CAS). readyNotifiedAt is cleared by return-to-line
   so a re-summon re-notifies; nextNotifiedAt is once per entry lifetime. */
ALTER TABLE "WalkInEntry" ADD COLUMN "readyNotifiedAt" TIMESTAMP(3);
ALTER TABLE "WalkInEntry" ADD COLUMN "nextNotifiedAt" TIMESTAMP(3);

/* The expiry sweep walks ACTIVE entries across EVERY shop in (joinedAt, id)
   keyset order. Every existing index is shopId-first and cannot serve a
   cross-tenant scan (the same reasoning as WaitlistEntry_active_sweep_idx). */
CREATE INDEX "WalkInEntry_active_sweep_idx"
  ON "WalkInEntry" ("joinedAt", "id")
  WHERE "status" IN ('WAITING','ASSIGNED','READY','IN_SERVICE');

/* 🔴 Seed the sweep's lease row. withLease acquires by UPDATE-only, so a
   job whose name has no row NEVER runs - it has shipped dead once already
   (acuity-resync). scheduler.leaseSeed.test.ts asserts this quoted literal
   exists in a committed migration: 'walk-in-expiry'. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('walk-in-expiry', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
