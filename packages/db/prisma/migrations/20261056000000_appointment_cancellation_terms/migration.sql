-- A booking keeps the cancellation terms it was made on.
--
-- The cancel engine and the card-on-file settlement read the shop's CURRENT
-- window, fee rate and card-fee switch, so a client who booked under "free
-- cancellation" could be charged after the owner tightened it. These columns
-- freeze the three at creation, on every path that creates an appointment.
--
-- Additive and nullable. Every existing row stays NULL, and NULL means "no
-- snapshot - settle by the shop's current settings", which is exactly how
-- every booking was settled before this migration. Nothing is backfilled: a
-- guess at what an old booking's terms were would be invented, not recorded.

ALTER TABLE "Appointment"
  ADD COLUMN "cancelWindowHoursAtBooking" INTEGER,
  ADD COLUMN "cancelFeeBpsAtBooking" INTEGER,
  ADD COLUMN "cardOnFileFeesAtBooking" BOOLEAN;

-- All three or none: a half-written snapshot would settle a booking on terms
-- nobody ever had. A window is never negative and a fee is 0..10000 bps (the
-- payments settings validate the same). Every branch is a plain
-- IS [NOT] NULL test or a comparison on a non-NULL column, so the expression
-- is never NULL - a CHECK that evaluates to NULL would pass anything.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_cancellation_terms_check"
  CHECK (
    ("cancelWindowHoursAtBooking" IS NULL
      AND "cancelFeeBpsAtBooking" IS NULL
      AND "cardOnFileFeesAtBooking" IS NULL)
    OR ("cancelWindowHoursAtBooking" IS NOT NULL
      AND "cancelFeeBpsAtBooking" IS NOT NULL
      AND "cardOnFileFeesAtBooking" IS NOT NULL
      AND "cancelWindowHoursAtBooking" >= 0
      AND "cancelFeeBpsAtBooking" >= 0
      AND "cancelFeeBpsAtBooking" <= 10000)
  );
