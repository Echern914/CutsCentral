-- Insights goals: one target per (metric, period) instead of one per shop.
--
-- "$4,000 a month" and "60 cuts a week" are DIFFERENT goals. The old unique on
-- shopId meant switching the metric or period in the UI overwrote the previous
-- target, so a barber tracking both lost one every time he looked at the other.
-- Each combination now keeps its own row (and its own number).
--
-- Existing rows are already unique per shop, so they satisfy the new composite
-- unique as-is: no data migration, no possibility of a conflict.

DROP INDEX "ShopGoal_shopId_key";

CREATE UNIQUE INDEX "ShopGoal_shopId_metric_period_key" ON "ShopGoal"("shopId", "metric", "period");

-- The shopId lookup is now non-unique (list a shop's goals), so it needs its own
-- index; the composite above can serve it, but an explicit one keeps the plan
-- stable if the composite's leading column ever changes.
CREATE INDEX "ShopGoal_shopId_idx" ON "ShopGoal"("shopId");
