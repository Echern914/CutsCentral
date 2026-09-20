-- Safe recovery for a group booking whose Acuity mirror came back AMBIGUOUS.
--
-- 🔴 THE HOLE THIS CLOSES. An UNKNOWN outbound row is one whose create never
-- got an answer: the block may or may not exist in Acuity. Releasing it blind
-- orphans a block on the barber's calendar forever - with no acuityBlockId
-- there is nothing to delete BY, and marking the row RELEASED throws away the
-- only record that something might be out there.
--
-- releaseForAppointment() bulk-set every row to RELEASING and only then called
-- releaseRow(), which re-reads the row - so releaseRow's own guard
-- ("an UNKNOWN with no id may still exist in Acuity - leave it for the
-- reconciler") could never fire. The intent was right; the bulk update
-- upstream defeated it.
ALTER TABLE "AcuityOutboundBlock" ADD COLUMN "releaseRequestedAt" TIMESTAMP(3);

-- A party whose blocks are not settled yet. The customer holds the chairs and
-- has been told "processing", never "booked": no confirmation goes out while
-- this is set, because the time cannot yet be promised as protected.
--
-- DURABLE on purpose - a process restart between the 202 and the settlement
-- must not lose a party that is holding real chairs.
ALTER TABLE "AppointmentGroup" ADD COLUMN "mirrorPendingSince" TIMESTAMP(3);

-- 🔴 THE IDEMPOTENCY MARKER for the ONE grouped confirmation, claimed with an
-- atomic UPDATE ... WHERE "confirmationSentAt" IS NULL before anything is
-- sent. The settlement sweep runs every five minutes; a replay must not put a
-- second "you are booked" in front of the same family.
ALTER TABLE "AppointmentGroup" ADD COLUMN "confirmationSentAt" TIMESTAMP(3);

-- The settlement sweep's work queue: parties still waiting on their mirror.
CREATE INDEX "AppointmentGroup_shopId_mirrorPendingSince_idx"
  ON "AppointmentGroup"("shopId", "mirrorPendingSince");
