-- THE BARBER APPROVES A LATE-CANCEL FEE BEFORE IT IS CHARGED (Drick, 2026-10-30).
--
-- Card-on-file shops: when a CLIENT cancels inside the free-cancel cutoff
-- (their appointment link, or the texting receptionist), the fee used to be
-- charged to their saved card on the spot. With this switch on, nothing is
-- charged: the fee waits on the appointment for the barber to Charge or Waive,
-- and the card is let go if neither happens within 7 days.
--
-- A barber's own taps (Mark no-show, "Client cancelled - charge $X") already
-- ask first, so they are unaffected.
--
-- Additive: the switch defaults OFF, so every shop keeps today's behaviour
-- until its owner ticks it; every existing appointment is NULL in all three
-- columns, which satisfies every constraint below.

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "cardFeeNeedsApproval" BOOLEAN NOT NULL DEFAULT false;

-- The fee waiting for the barber: the figure THIS booking's terms gave at the
-- moment the client cancelled, and when.
ALTER TABLE "Appointment" ADD COLUMN "cardFeeAwaitingCents" INTEGER;
ALTER TABLE "Appointment" ADD COLUMN "cardFeeAwaitingSince" TIMESTAMP(3);
-- The barber waived it, or nobody decided in time and the card was let go.
ALTER TABLE "Appointment" ADD COLUMN "cardFeeWaivedAt" TIMESTAMP(3);

-- A figure and a time arrive together and leave together.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_cardFeeAwaiting_complete_check"
  CHECK (
    ("cardFeeAwaitingCents" IS NULL AND "cardFeeAwaitingSince" IS NULL)
    OR ("cardFeeAwaitingCents" IS NOT NULL AND "cardFeeAwaitingSince" IS NOT NULL)
  );

-- Same $1,000 ceiling as the flat fee; never a zero or negative fee.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_cardFeeAwaiting_amount_check"
  CHECK ("cardFeeAwaitingCents" IS NULL OR ("cardFeeAwaitingCents" >= 1 AND "cardFeeAwaitingCents" <= 100000));

-- The lapse sweep reads only the handful of fees still waiting.
CREATE INDEX IF NOT EXISTS "Appointment_cardFeeAwaiting_idx"
  ON "Appointment"("cardFeeAwaitingSince") WHERE "cardFeeAwaitingSince" IS NOT NULL;
