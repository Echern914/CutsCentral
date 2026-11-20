-- Shops that signed up while the free trial was 7 days get the 14 the product
-- promises again.
--
-- WHY. #740 (2026-11-08) cut the trial for new shops from 14 days to 7; the
-- owner reversed that on 2026-11-20. Signup saves the end date on the shop, so
-- changing BILLING.trialDays back reaches only shops created afterwards. A shop
-- that joined in between would see "14 days free" on the site while holding 7.
--
-- WHICH SHOPS. Created on or after 2026-11-09 UTC, never subscribed, and whose
-- saved trial is still 7-day SHAPED: its length is 7 days, or 7 days plus whole
-- 30-day referral months (services/referral.ts adds 30 days at a time, so a
-- referred shop sits at 37). A shop created after the trial went back to 14 is
-- 14-day shaped and does not match. Each matching shop gets 7 more days.
--
-- THE REMINDER MARK. Shop.trialReminderStage is a high-water mark of the trial
-- emails already sent. A shop whose trial is running again after this goes back
-- to 0, so it hears "ends in N days", "ends tomorrow" and "has ended" for its
-- real end date. Without that, a shop already told "your trial has ended" would
-- be unlocked and then locked again a week later in silence. A shop whose new
-- end date is still in the past keeps its mark.
--
-- Postgres evaluates every SET expression against the row as it was, so the
-- CASE below reads the OLD end date. The columns are UTC timestamps without a
-- zone, hence now() AT TIME ZONE 'UTC'.
--
-- The prefix is a SEQUENCE NUMBER, not a date (see CLAUDE.md): 20261095000000
-- is the last one on main.
--
-- DATA ONLY, idempotent: after one run no shop is 7-day shaped.
UPDATE "Shop"
   SET "trialReminderStage" = CASE
         WHEN "trialEndsAt" + interval '7 days' > (now() AT TIME ZONE 'UTC') THEN 0
         ELSE "trialReminderStage"
       END,
       "trialEndsAt" = "trialEndsAt" + interval '7 days'
 WHERE "createdAt" >= TIMESTAMP '2026-11-09 00:00:00'
   AND "subscriptionStatus" = 'none'
   AND "trialEndsAt" IS NOT NULL
   AND MOD(EXTRACT(EPOCH FROM ("trialEndsAt" - "createdAt"))::numeric, 2592000)
       BETWEEN 601200 AND 608400;
