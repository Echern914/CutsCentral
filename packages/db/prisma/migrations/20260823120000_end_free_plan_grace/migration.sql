-- The free plan is going away. Give everyone standing on it 30 days' notice.
--
-- Until now a shop whose trial ran out kept a real product: dashboard, client
-- book, punch cards, mini-site, insights. It lost only texting and online
-- booking. From this release there is one plan, and lapsing means the shop
-- stops working. Anyone already living on the old free tier would otherwise
-- lose access the moment this deploys, with no warning at all.
--
-- Rather than a permanent legacy-free branch in every gate, this just moves
-- their trial: 30 days from deploy, on the same clock as everybody else, and
-- the wall then treats them identically. No second code path to maintain.
--
-- Resetting trialReminderStage is the load-bearing half. runTrialReminders
-- filters `trialReminderStage < 3`, and these shops are all sitting at 3
-- (already-expired) or were never reminded at all, so without the reset they
-- would hit the wall in 30 days having received NOTHING.

UPDATE "Shop"
   SET "trialEndsAt"        = now() + interval '30 days',
       "trialReminderStage" = 0
 WHERE "compAccess" = false
   -- 'none' = never subscribed. A shop sitting at 'canceled' chose to leave
   -- and already knows; it is not owed a fresh 30 free days.
   AND "subscriptionStatus" = 'none'
   AND ("trialEndsAt" IS NULL OR "trialEndsAt" < now());

-- Idempotent by construction: every row this touches ends up with trialEndsAt
-- 30 days in the FUTURE, so a re-run matches nothing and cannot stack a second
-- extension. No NOT EXISTS guard needed.
