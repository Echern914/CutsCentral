-- Business type: record whether a human actually CHOSE the shop's vertical.
--
-- Additive and non-destructive. The previously deployed API never reads this
-- column, so prod keeps working through the deploy window (same playbook as
-- 20260612100000_billing_industry and 20260611020000_shop_page). Nothing is
-- renamed, nothing is deleted, and `Shop.industry` is not touched.
ALTER TABLE "Shop" ADD COLUMN "businessTypeSelectedAt" TIMESTAMP(3);

-- NULL means "the stored industry is a DEFAULT, not an answer". Such a shop
-- renders NEUTRAL vocabulary and is offered a one-time picker, rather than being
-- presented as a barbershop it never claimed to be.
--
-- Three cohorts exist, established from the git history rather than guessed:
--   before 2026-06-13  no picker at all; `industry` came from the ALTER's
--                      DEFAULT 'barber' in 20260612100000_billing_industry.
--   06-13 .. 06-28     a249a68 shipped a picker, but as useState("barber") -
--                      pre-selected and not required, so an owner who never
--                      touched it still submitted "barber". Also a default.
--   from   2026-06-28  dbb2b6a made it useState("") + a disabled placeholder +
--                      required: the first genuinely explicit choice.
--
-- So only the third cohort is stamped, and only from each shop's OWN createdAt,
-- so the timestamp records something true instead of inventing a moment.
--
-- The cutoff is biased one day LATE on purpose. The two errors are not
-- symmetric: a false NULL costs one owner a single tap, while a false stamp
-- silently locks (say) a nail studio into barbershop wording permanently, with
-- no remaining signal that we ought to have asked.
UPDATE "Shop"
   SET "businessTypeSelectedAt" = "createdAt"
 WHERE "createdAt" >= TIMESTAMP '2026-06-29 00:00:00';
