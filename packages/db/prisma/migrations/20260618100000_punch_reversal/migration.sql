-- Barber-correctable punch ledger. The ledger stays append-only: "undo a punch"
-- writes a NEW offsetting correction row and stamps reversedAt on the original,
-- so the balance self-heals while the full history (including what was undone)
-- is preserved. No row is ever deleted, so the runningBalance snapshots already
-- written stay valid.
--
-- reversedAt:   set on an ORIGINAL row once it has been reversed (so it can't be
--               reversed twice).
-- reversalOfId: set on a CORRECTION row, pointing at the original it reverses
--               (self FK; SetNull so a teardown cascade can't dangle).

-- AlterTable
ALTER TABLE "PunchLedger" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "PunchLedger" ADD COLUMN "reversalOfId" TEXT;

-- CreateIndex
CREATE INDEX "PunchLedger_reversalOfId_idx" ON "PunchLedger"("reversalOfId");

-- AddForeignKey (self-relation: a correction row -> the original it reverses)
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "PunchLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No RLS changes needed: PunchLedger already has tenant_isolation enabled +
-- FORCE RLS + chairback_app grants from the init/RLS migrations. RLS is
-- row-level, so the new columns are covered automatically.
