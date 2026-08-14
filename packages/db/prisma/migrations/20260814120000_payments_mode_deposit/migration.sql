-- Add the `deposit` payments mode.
--
-- 🔴 THIS MIGRATION DOES NOTHING ELSE, ON PURPOSE. Postgres will not let a new
-- enum value be USED in the same transaction that adds it ("unsafe use of new
-- value of enum type"), and Prisma wraps each migration in one. So the ADD VALUE
-- ships alone and the column that defaults/filters on it lands in the NEXT
-- migration. Same split the Square integration needed for `square`
-- (20260628100000 enum-add, then 20260628110000 table).
ALTER TYPE "PaymentsMode" ADD VALUE IF NOT EXISTS 'deposit';
