-- A TIP THE SHOP RECORDED BY HAND: money a client handed over outside
-- ChairBack's card flow (cash, or another app), typed on the appointment
-- sheet's Tip row. A record only - no money moves and Stripe is never called.
--
-- Additive and nullable: every existing row is NULL in all four columns, which
-- satisfies every constraint below.

ALTER TABLE "Appointment" ADD COLUMN "recordedTipCents" INTEGER;
ALTER TABLE "Appointment" ADD COLUMN "recordedTipMethod" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "recordedTipAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "recordedTipByUserId" TEXT;

-- Whole cents, $0.01 to $500 (config/tips.ts RECORDED_TIP_MAX_CENTS). The
-- route validates first; this is the floor a future writer cannot get under.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_recordedTip_amount_check"
  CHECK ("recordedTipCents" IS NULL OR ("recordedTipCents" >= 1 AND "recordedTipCents" <= 50000));

-- How it was received. 'cash' or 'other' (Cash App, Venmo, Zelle...). A card
-- tip is never recorded here - it is a `tip` Payment row Stripe settled.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_recordedTip_method_check"
  CHECK ("recordedTipMethod" IS NULL OR "recordedTipMethod" IN ('cash', 'other'));

-- An amount, a method and a time arrive together and leave together: a tip
-- with no method, or a method with no tip, is a half-written record.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_recordedTip_complete_check"
  CHECK (
    ("recordedTipCents" IS NULL AND "recordedTipMethod" IS NULL AND "recordedTipAt" IS NULL)
    OR ("recordedTipCents" IS NOT NULL AND "recordedTipMethod" IS NOT NULL AND "recordedTipAt" IS NOT NULL)
  );
