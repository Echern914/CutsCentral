-- Add 'PENDING' to AppointmentStatus so a public native booking can land as a
-- request awaiting barber approval (request-before-booking).
--
-- ISOLATED in its own migration ON PURPOSE: Postgres cannot USE a newly-added
-- enum value in the same transaction that adds it (ALTER TYPE ... ADD VALUE),
-- and Prisma wraps each migration file in one transaction. The column + the
-- widened partial-unique index that reference 'PENDING' are the next, separate
-- migration. IF NOT EXISTS makes this re-appliable. (Same pattern as
-- 20260628100000_booking_mode_square and 20260623120000_push_channel_enum.)
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'PENDING';
