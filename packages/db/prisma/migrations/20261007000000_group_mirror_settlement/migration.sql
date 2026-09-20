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
-- atomic UPDATE ... WHERE "confirmationEnqueuedAt" IS NULL.
--
-- ENQUEUED, NOT SENT. It is stamped in the same transaction that writes the
-- durable EmailIntent, so it records that a PROMISE exists - never that a
-- provider accepted anything. The provider-confirmed fact lives on
-- "Appointment"."confirmationEmailSentAt", written only after a good send.
-- Calling this column "...SentAt" invited exactly the reading that caused the
-- bug it now guards: stamp it, treat it as sent, lose the email on a crash.
--
-- The settlement sweep runs every five minutes; a replay must not put a second
-- "you are booked" in front of the same family.
ALTER TABLE "AppointmentGroup" ADD COLUMN "confirmationEnqueuedAt" TIMESTAMP(3);

-- The settlement sweep's work queue: parties still waiting on their mirror.
CREATE INDEX "AppointmentGroup_shopId_mirrorPendingSince_idx"
  ON "AppointmentGroup"("shopId", "mirrorPendingSince");

-- The grouped confirmation rides the EXISTING durable outbox -----------------
--
-- 🔴 WHY IT HAD TO. The settlement stamped a marker it called
-- `confirmationSentAt` and then fire-and-forgot a direct sendEmail(). The name
-- was half the bug: the column recorded an INTENT and was read as a delivery.
-- It is `confirmationEnqueuedAt` now, and the only thing that may be called a
-- send is "Appointment"."confirmationEmailSentAt".
--
-- A crash between the stamp and the provider - a deploy,
-- an OOM, a frozen instance - lost the confirmation PERMANENTLY: the marker
-- was already set, so nothing retried, and a family holding three real chairs
-- was never told they were booked. Dropping the marker instead would have
-- traded that for the opposite failure, a second "you are booked" on every
-- replay of a sweep that runs each five minutes.
--
-- Neither is acceptable and neither needed a new mechanism. EmailIntent is the
-- durable outbox this codebase already has: the row is written in the SAME
-- transaction that claims the confirmation, the worker owns delivery with
-- bounded retries, and the idempotency key is handed to Resend so a retry
-- after an ambiguous accept is collapsed by the PROVIDER rather than hoped
-- about here.
--
-- EmailIntent.kind is CHECK-pinned, so the vocabulary is re-pinned in FULL -
-- never a partial list - and nothing about the existing kinds changes. The
-- status CHECK is untouched.
ALTER TABLE "EmailIntent"
  DROP CONSTRAINT IF EXISTS "EmailIntent_kind_check";
ALTER TABLE "EmailIntent"
  ADD CONSTRAINT "EmailIntent_kind_check"
  CHECK ("kind" IN (
    'appointment_canceled',
    'affiliate_approved',
    'affiliate_rejected',
    'affiliate_reward_qualified',
    'affiliate_reward_available',
    'affiliate_reward_reversed',
    'group_confirmation'
  ));
