/* EVERY AFFILIATE GETS PAID IN DOLLARS (policy v4, owner decision 2026-11-02).

   A month off per business is retired as a reward style. Accounts approved
   before 2026-10-30 were backfilled to 'month_off' by the dollar-credit
   migration; they move to 'dollar_credit' here, so they earn $10 when a
   business they brought on pays its first month and $5 for every month after.

   Forward only, like a style change from the dashboard: a reward already
   earned keeps the type it was earned under (AffiliateReward.rewardType is
   untouched, and 'subscription_credit' stays a valid reward type so any month
   off already earned is still honoured).

   🔴 NOTHING HERE MOVES MONEY. Idempotent: a second run finds no 'month_off'
   account and writes nothing. */

/* 1. Each account that moves gets the same audit event a dashboard change
      writes, attributed to the system. Written BEFORE the update so the
      WHERE still sees who is moving. */
INSERT INTO "AffiliateAuditEvent"
  ("id", "shopId", "accountId", "type", "actorType", "metadata", "createdAt")
SELECT
  'aud' || replace(gen_random_uuid()::text, '-', ''),
  a."shopId",
  a."id",
  'account.reward_style_set',
  'system',
  '{"source":"migration","rewardStyle":"dollar_credit"}'::jsonb,
  now()
FROM "AffiliateAccount" a
WHERE a."rewardStyle" = 'month_off';

UPDATE "AffiliateAccount"
SET "rewardStyle" = 'dollar_credit', "rewardStyleSetAt" = now()
WHERE "rewardStyle" = 'month_off';

/* The CHECK keeps allowing 'month_off' on purpose: the qualification engine's
   month-off path still releases holds on, and reverses, months off that were
   already earned, and its tests build month-off accounts directly. Nobody can
   CHOOSE it any more - the API's reward-style list is now dollar_credit only
   (AFFILIATE_REWARD_STYLES in @chairback/config). */
