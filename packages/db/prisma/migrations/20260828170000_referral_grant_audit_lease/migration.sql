/* Lease seed for the referral-grant audit job.

   🔴 A scheduled job whose name has no job_lease row NEVER runs - withLease
   cannot acquire a lease that does not exist, so the job silently does nothing
   forever. That has shipped dead once already (acuity-resync).
   scheduler.leaseSeed.test.ts asserts this quoted literal exists in a
   committed migration: 'referral-grant-audit'.

   Data only: no schema change, no table touched. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('referral-grant-audit', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
