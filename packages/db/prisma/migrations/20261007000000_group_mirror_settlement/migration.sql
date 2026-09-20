-- Safe settlement for a group booking whose Acuity mirror came back AMBIGUOUS.
--
-- 🔴 THE ACUITY RELEASE HALF OF THIS WORK IS NOT HERE. An earlier revision of
-- this branch carried its own `AcuityOutboundBlock.releaseRequestedAt` column
-- and its own engine changes for the UNKNOWN-release defect. That fix shipped
-- first, on main, as #458 (`20261006000000_acuity_release_requested`), which
-- records the intent as `releaseRequested` plus a `lastCreateAttemptAt` clock.
-- Main's implementation is authoritative and this migration adds nothing to
-- it - two columns meaning "somebody asked for this to be released" would be
-- two sources of truth for one fact, and the reconciler would read whichever
-- one the author of the day happened to remember.
--
-- What remains here is only what is GROUP-shaped.

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
