-- Fuzzy, typo-tolerant, full-name client search for the Clients-page typeahead.
--
-- The old search was `firstName ILIKE %q% OR lastName ILIKE %q% OR ...` on each
-- column separately, so "Marcus Thompson" (first + last together) matched
-- nothing, "Jon" never found "John", and results came back in list-sort order
-- rather than best-match-first. This adds Postgres trigram similarity so the
-- query in GET /api/dashboard/clients?q= can match a concatenated full name,
-- tolerate typos via similarity(), and ORDER BY relevance.
--
-- Both extensions ship with Supabase (and stock Postgres contrib). CREATE ...
-- IF NOT EXISTS is idempotent and safe to re-run. unaccent lets "José" match
-- "jose". These live in the default (public) schema; the app role only needs
-- USAGE, which it already has as a public-schema function caller.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- GIN trigram indexes so both similarity() and ILIKE '%q%' stay index-backed as
-- a shop's client list grows (a plain ILIKE '%...%' can't use a btree). One per
-- searchable column; the query ORs across them. gin_trgm_ops is what makes
-- %-wrapped ILIKE and % / similarity() sargable.
CREATE INDEX IF NOT EXISTS "Client_firstName_trgm_idx" ON "Client" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_lastName_trgm_idx"  ON "Client" USING gin ("lastName"  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_email_trgm_idx"     ON "Client" USING gin ("email"     gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_phone_trgm_idx"     ON "Client" USING gin ("phone"     gin_trgm_ops);

-- Full-name index: trigrams over "first last" as ONE string, so a full-name
-- query is one index probe instead of a cross-column guess. The expression must
-- be IMMUTABLE to index: `lower`, `coalesce`, and `||` are immutable, whereas
-- concat_ws is only STABLE (Postgres rejects it here). unaccent is NOT immutable
-- either, so it is applied in the QUERY, not baked into this index. The query's
-- full-name expression must match this exactly for the index to be used.
CREATE INDEX IF NOT EXISTS "Client_fullname_trgm_idx" ON "Client"
  USING gin ((lower(coalesce("firstName", '') || ' ' || coalesce("lastName", ''))) gin_trgm_ops);
