-- New states a broadcast and one of its recipients can actually be in.
--
-- ISOLATED IN ITS OWN MIGRATION ON PURPOSE: Postgres cannot USE a newly added
-- enum value in the same transaction that adds it, and Prisma wraps each
-- migration file in one transaction. The tables, indexes and lease seed that
-- reference these are the next, separate migration. IF NOT EXISTS makes this
-- re-appliable.
--
-- QUEUED  - the audience is frozen and the allowance is reserved, but nothing
--           has left. This is the only thing the send response may claim.
-- PARTIAL - some recipients landed and some did not. Neither SENT nor FAILED
--           is true of that run, and asserting either one would put a claim in
--           the ledger the rows underneath do not support.
ALTER TYPE "BroadcastStatus" ADD VALUE IF NOT EXISTS 'QUEUED' BEFORE 'SENDING';
ALTER TYPE "BroadcastStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

-- ABANDONED - we stopped WITHOUT KNOWING whether the provider accepted the
-- last attempt, and the window in which a retry would have been collapsed has
-- closed. Counted with the failures, never called one.
ALTER TYPE "BroadcastSendStatus" ADD VALUE IF NOT EXISTS 'ABANDONED';
