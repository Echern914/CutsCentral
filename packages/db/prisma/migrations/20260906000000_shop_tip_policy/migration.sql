-- Does the price a customer sees already include a tip?
--
-- DISPLAY ONLY. Nothing here changes what is charged. It answers the question a
-- customer asks at the moment they hand money over, which got sharper the day
-- pay-ahead started collecting the full ticket up front: "do I still tip?"
--
-- NULL says NOTHING, and that is the point. Every existing shop is NULL, so
-- deploying this changes not one booking page until a barber chooses. Picking a
-- default here would put a claim about money in a shop's mouth that they never
-- made - and either default would be wrong for half of them.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "tipPolicy" TEXT;

-- CHECK, not an enum: a CHECK is additive, so a third answer ("tip suggested at
-- checkout", say) is one migration rather than an enum rewrite. Drop-and-add so
-- re-running this file is a no-op.
ALTER TABLE "Shop" DROP CONSTRAINT IF EXISTS "Shop_tipPolicy_check";
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_tipPolicy_check"
  CHECK ("tipPolicy" IS NULL OR "tipPolicy" IN ('included', 'not_included'));

-- Deliberately NO index: this column is read only as part of a Shop row that is
-- already being loaded by primary key or slug, and never scanned on.
