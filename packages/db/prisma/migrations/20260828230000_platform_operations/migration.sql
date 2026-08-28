/* Durable platform operations (first consumer: the one-time rewards-link
   corpus retirement) + per-client Wallet-pass refresh tasks.

   The record stores state, counts and a cursor ONLY - never a token, URL,
   phone number, client name or message body. Batches commit atomically
   (rotate + checkpoint in one transaction), so a crash resumes exactly at
   the last committed checkpoint and no client rotates twice for one run. */

CREATE TABLE "PlatformOperation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "initiatedByUserId" TEXT NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "checkpoint" TEXT,
    "rotatedCount" INTEGER NOT NULL DEFAULT 0,
    "passPendingCount" INTEGER NOT NULL DEFAULT 0,
    "passSucceededCount" INTEGER NOT NULL DEFAULT 0,
    "passFailedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformOperationPassTask" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOperationPassTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformOperation_kind_status_idx" ON "PlatformOperation"("kind", "status");
CREATE UNIQUE INDEX "PlatformOperationPassTask_operationId_clientId_key"
    ON "PlatformOperationPassTask"("operationId", "clientId");
CREATE INDEX "PlatformOperationPassTask_operationId_status_idx"
    ON "PlatformOperationPassTask"("operationId", "status");

ALTER TABLE "PlatformOperationPassTask"
    ADD CONSTRAINT "PlatformOperationPassTask_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "PlatformOperation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatformOperationPassTask"
    ADD CONSTRAINT "PlatformOperationPassTask_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

/* 🔴 EXCLUSIVITY IS A PROPERTY OF THE INDEX, not of any process: at most one
   PENDING/RUNNING operation per kind. Two concurrent valid confirmations race
   INSERTs; exactly one wins, the loser reads the winner's run. */
CREATE UNIQUE INDEX "PlatformOperation_one_active_per_kind"
    ON "PlatformOperation"("kind")
    WHERE "status" IN ('PENDING', 'RUNNING');

/* CHECK-pinned vocabularies (the alter-under-traffic lesson: pin them now). */
ALTER TABLE "PlatformOperation"
    ADD CONSTRAINT "PlatformOperation_kind_check"
    CHECK ("kind" IN ('rewards_rotate_all'));
ALTER TABLE "PlatformOperation"
    ADD CONSTRAINT "PlatformOperation_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'));
ALTER TABLE "PlatformOperation"
    ADD CONSTRAINT "PlatformOperation_errorCode_check"
    CHECK ("errorCode" IS NULL OR "errorCode" IN ('batch_error', 'pass_phase_error'));
ALTER TABLE "PlatformOperationPassTask"
    ADD CONSTRAINT "PlatformOperationPassTask_status_check"
    CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED'));

/* 🔴 DEFAULT-DENY, same intentional shape as PhoneRecoveryCode: revoke
   explicitly first (under ALTER DEFAULT PRIVILEGES a new table may carry
   grants), then RLS enabled + FORCED with NO policy - the app role holds
   zero privileges here and every access goes through the owner-executed
   rotation service. */
REVOKE ALL ON "PlatformOperation" FROM chairback_app;
ALTER TABLE "PlatformOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformOperation" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "PlatformOperationPassTask" FROM chairback_app;
ALTER TABLE "PlatformOperationPassTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformOperationPassTask" FORCE ROW LEVEL SECURITY;

/* Lease seed for the rotation worker job - a scheduled name with no job_lease
   row NEVER runs (withLease is UPDATE-only). scheduler.leaseSeed.test.ts
   asserts this quoted literal exists: 'rewards-rotation'. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('rewards-rotation', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
