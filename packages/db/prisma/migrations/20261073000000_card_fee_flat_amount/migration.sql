-- A shop can set its card-on-file no-show / late-cancel fee as a FLAT amount
-- (Drick: "$25 for a no-show") instead of a percentage of the price.
--
-- Why the existing columns can't: cancelFeeBps is a share of the price, so no
-- value of it is "$25" across services priced differently.
--
-- Additive and nullable. NULL = the percentage, which is every shop and every
-- booking today, so nothing changes until an owner picks a flat amount.

ALTER TABLE "Shop" ADD COLUMN "cardFeeFlatCents" INTEGER;

-- $1..$1,000, the same bounds the payments settings validate (and the deposit
-- uses). NULL passes a CHECK, which is the "percentage" case.
ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_cardFeeFlatCents_check"
  CHECK ("cardFeeFlatCents" IS NULL OR ("cardFeeFlatCents" >= 100 AND "cardFeeFlatCents" <= 100000));

-- The booking keeps the flat amount it was made on, beside the three terms it
-- already snapshots (20261056000000). Existing rows stay NULL = the
-- percentage they were made on.
ALTER TABLE "Appointment" ADD COLUMN "cardFeeFlatCentsAtBooking" INTEGER;

-- Only ever part of a whole snapshot, and positive: a flat amount on a booking
-- with no snapshot would be settled by the shop's current terms anyway, so it
-- could only mislead. Both branches are never NULL.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_cardFeeFlatCentsAtBooking_check"
  CHECK (
    "cardFeeFlatCentsAtBooking" IS NULL
    OR ("cancelFeeBpsAtBooking" IS NOT NULL AND "cardFeeFlatCentsAtBooking" > 0)
  );
