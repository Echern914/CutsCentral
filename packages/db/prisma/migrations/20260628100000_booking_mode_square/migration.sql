-- Add 'square' to BookingMode so a shop can pick Square Appointments as its ONE
-- active booking source (alongside link/acuity/native).
--
-- ISOLATED in its own migration ON PURPOSE: Postgres cannot use a newly-added
-- enum value in the same transaction that adds it (ALTER TYPE ... ADD VALUE),
-- and Prisma wraps each migration file in one transaction. The SquareConnection
-- table is the next, separate migration. IF NOT EXISTS makes this re-appliable.
ALTER TYPE "BookingMode" ADD VALUE IF NOT EXISTS 'square';
