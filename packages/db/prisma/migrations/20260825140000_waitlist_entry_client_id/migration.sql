-- Waitlist: give an entry a LINK to the client it belongs to. Shape only.
--
-- WaitlistEntry has never known who it is about. It carries a name, a phone
-- and an email typed into a public form, and everything downstream that needs
-- the actual Client record re-derives it by matching the phone string, once
-- per page of the candidate scan (engines/waitlistOffer.ts).
--
-- That is fine for reachability, which only asks "is there a live client we
-- can push to". It is not enough to RANK by anything that lives on Client -
-- loyalty tier, in particular - because a rank has to be expressible in the
-- ORDER BY, and a phone string resolved in JS after the page comes back is
-- not. This column is what makes that possible; nothing orders by it yet.
--
-- ZERO behaviour change. Reachability prefers the link and falls back to the
-- identical phone lookup for any row the backfill could not resolve, and the
-- backfill only writes links that lookup would have produced anyway.

/* ---------------------------------------------------------------- */
/* 1. The column                                                      */
/* ---------------------------------------------------------------- */

ALTER TABLE "WaitlistEntry" ADD COLUMN "clientId" TEXT;

-- "Which entries belong to this client" - the report query below, and the
-- join the tier ranking will need.
CREATE INDEX "WaitlistEntry_shopId_clientId_idx"
  ON "WaitlistEntry"("shopId", "clientId");

-- SET NULL, not CASCADE: deleting a client must never delete somebody's place
-- in the queue. The row falls back to the phone match, which is exactly where
-- it started.
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

/* ---------------------------------------------------------------- */
/* 2. Backfill: EXACTLY the match the runtime already performs        */
/* ---------------------------------------------------------------- */

-- The rule, and it is the only rule (engines/waitlistClientLink.ts states the
-- same one for writes): a non-archived Client in the SAME shop whose phone
-- string is byte-identical to the entry's.
--
-- 🔴 UNAMBIGUOUS ONLY. Two live clients can share a number - a household, a
-- shop phone, a duplicate nobody merged. The runtime's phone map resolves that
-- by last-write-wins, which is to say by whatever order the rows came back in.
-- Guessing is acceptable when the answer is only "can we push to someone";
-- it is not acceptable when the answer becomes "whose loyalty tier is this".
-- Those entries stay NULL and keep using the phone lookup they use today.
--
-- No normalization on either side. The runtime compares the raw strings, so a
-- backfill that normalized would create links the fallback disagrees with.
--
-- Idempotent: only fills rows that are still NULL.
UPDATE "WaitlistEntry" w
SET "clientId" = c."id"
FROM (
  SELECT "shopId", "phone", MIN("id") AS "id"
  FROM "Client"
  WHERE "archivedAt" IS NULL
    AND "phone" IS NOT NULL
    AND "phone" <> ''
  GROUP BY "shopId", "phone"
  HAVING COUNT(*) = 1
) c
WHERE w."clientId" IS NULL
  AND w."phone" IS NOT NULL
  AND w."phone" <> ''
  AND w."shopId" = c."shopId"
  AND w."phone"  = c."phone";

/* ---------------------------------------------------------------- */
/* 3. Report: how many rows did NOT resolve, and why                  */
/* ---------------------------------------------------------------- */

-- Prisma does not reliably surface server notices, so this is best-effort
-- when it runs under `migrate deploy`. The same five numbers are available
-- on demand, against any environment, from
--   pnpm --filter @chairback/db report:waitlist-links
-- which runs the identical query. Coverage is worth knowing because an
-- unlinked row is a row the tier ranking cannot see.
DO $$
DECLARE
  total     bigint;
  linked    bigint;
  no_phone  bigint;
  no_match  bigint;
  ambiguous bigint;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE w."clientId" IS NOT NULL),
    count(*) FILTER (WHERE w."clientId" IS NULL
                       AND (w."phone" IS NULL OR w."phone" = '')),
    count(*) FILTER (WHERE w."clientId" IS NULL
                       AND w."phone" IS NOT NULL AND w."phone" <> ''
                       AND NOT EXISTS (
                         SELECT 1 FROM "Client" c
                         WHERE c."shopId" = w."shopId" AND c."phone" = w."phone"
                           AND c."archivedAt" IS NULL)),
    count(*) FILTER (WHERE w."clientId" IS NULL
                       AND w."phone" IS NOT NULL AND w."phone" <> ''
                       AND (SELECT count(*) FROM "Client" c
                            WHERE c."shopId" = w."shopId" AND c."phone" = w."phone"
                              AND c."archivedAt" IS NULL) > 1)
  INTO total, linked, no_phone, no_match, ambiguous
  FROM "WaitlistEntry" w;

  -- PL/pgSQL's RAISE has ONE placeholder, %, no format spec (round here), and
  -- %%% is ambiguous - it reads as a literal % then a placeholder, which puts
  -- the sign on the wrong side of the number. Spell the word instead.
  RAISE NOTICE 'WaitlistEntry.clientId backfill: % of % linked (% percent)',
    linked, total,
    CASE WHEN total = 0 THEN 0
         ELSE round(linked::numeric * 100 / total, 1) END;
  RAISE NOTICE '  unlinked - no phone on the entry : %', no_phone;
  RAISE NOTICE '  unlinked - no live client match  : %', no_match;
  RAISE NOTICE '  unlinked - phone is ambiguous    : %', ambiguous;
END
$$;
