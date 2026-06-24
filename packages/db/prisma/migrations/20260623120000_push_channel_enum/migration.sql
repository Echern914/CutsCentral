-- Add the WEB_PUSH value to MessageChannel so a Nudge can record a push send
-- (the free, push-first leg of a loyalty/rebooking send) alongside SMS.
--
-- ISOLATED in its own migration ON PURPOSE: Postgres cannot use a newly-added
-- enum value in the same transaction that adds it (ALTER TYPE ... ADD VALUE),
-- and Prisma wraps each migration file in one transaction. The PushSubscription
-- table migration (which is what actually leads to WEB_PUSH rows) is the next,
-- separate migration. IF NOT EXISTS makes this safe to re-apply.
ALTER TYPE "MessageChannel" ADD VALUE IF NOT EXISTS 'WEB_PUSH';
