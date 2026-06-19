-- Soft-archive for clients. A barber can hide a client they no longer want in
-- their active book without destroying history: archivedAt is set, the row is
-- never deleted. An archived client is excluded from every "active" surface
-- (clients list default, stats, leaderboard, at-risk, all SMS sends) but stays
-- reachable by id so it can be un-archived. archivedAt = null means active.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex (the default list/stats queries filter on (shopId, archivedAt))
CREATE INDEX "Client_shopId_archivedAt_idx" ON "Client"("shopId", "archivedAt");

-- No RLS changes needed: Client already has tenant_isolation + FORCE RLS +
-- chairback_app grants from the init/RLS migrations. RLS is row-level, so the
-- new column is covered automatically.
