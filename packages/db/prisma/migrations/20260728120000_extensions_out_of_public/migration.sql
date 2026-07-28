-- Move pg_trgm and unaccent out of the `public` schema.
--
-- Supabase's security linter (splinter) raises "Extension in Public" for both.
-- 20260726170000_client_search_trgm created them with a bare CREATE EXTENSION,
-- which lands in the default creation schema (public). Two reasons to move them:
-- extension functions in `public` sit in the default search_path and can collide
-- with our own objects, and on a stock Supabase project PostgREST auto-exposes
-- `public`, making similarity()/unaccent() callable over the REST API. We drive
-- the DB through Prisma rather than PostgREST, so this is namespace hygiene, not
-- a live hole - but it is cheap to be correct.
--
-- IMPORTANT - this migration is deliberately NOT fault-tolerant about the move
-- itself. apps/api ships SQL schema-qualified to `extensions`, and Railway runs
-- `migrate deploy` in preDeploy, before the new code serves traffic. A hard
-- failure here aborts the deploy and leaves the old code running against the old
-- schema, which is the safe outcome. Swallowing the error would ship code that
-- 500s on every client search instead.

-- Supabase provisions this schema already; plain Postgres (local, test, CI) does
-- not, and a fresh dev DB replays every migration from scratch.
CREATE SCHEMA IF NOT EXISTS extensions;

-- Tenant queries run as chairback_app (see 20260607010000_rls_grant_app_role),
-- not as the connecting owner role, so USAGE has to reach that role. PUBLIC
-- covers it plus every other current and future role without naming any. On
-- Supabase the schema may be owned by supabase_admin and the grant may already
-- be in place, so a failure here is not necessarily fatal - the assertion at the
-- bottom is what actually decides.
DO $$
BEGIN
  GRANT USAGE ON SCHEMA extensions TO PUBLIC;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not GRANT USAGE ON SCHEMA extensions: %', SQLERRM;
END
$$;

-- Only move an extension that is still in `public`, so re-running this (or
-- running it where Supabase already placed the extension elsewhere) is a no-op
-- rather than an error. The move carries the operator class and the unaccent
-- text-search dictionary along with the functions. Indexes already built with
-- gin_trgm_ops keep working untouched - an index binds its opclass by OID, not
-- by name - and the planner still matches them once the query names the
-- operator as OPERATOR(extensions.%).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
  ) THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'unaccent' AND n.nspname = 'public'
  ) THEN
    ALTER EXTENSION unaccent SET SCHEMA extensions;
  END IF;
END
$$;

-- Safety net, NOT what the app relies on: put `extensions` on the database-wide
-- search_path so anything still resolving these names unqualified keeps working
-- - most importantly a FUTURE migration writing `CREATE INDEX ... gin_trgm_ops`,
-- which is easy to write out of habit and would otherwise fail. Takes effect for
-- new connections only. The client-search query in apps/api is fully qualified
-- and does not depend on this. Guarded because a managed environment may refuse
-- ALTER DATABASE, and that alone should not fail the deploy.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET search_path = %s',
    current_database(),
    '"$user", public, extensions'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not set database-level search_path: %', SQLERRM;
END
$$;

-- Assert the end state we actually depend on. Without this, a partially-applied
-- move (extension relocated but chairback_app unable to reach it) would look
-- like a clean deploy and then 500 on the first client search. Fail here
-- instead, while the old version is still serving.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname IN ('pg_trgm', 'unaccent') AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'pg_trgm/unaccent are still in public - the schema move did not take';
  END IF;

  IF NOT has_schema_privilege('chairback_app', 'extensions', 'USAGE') THEN
    RAISE EXCEPTION
      'chairback_app lacks USAGE on schema extensions - client search would fail at runtime';
  END IF;
END
$$;
