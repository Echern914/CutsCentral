-- Close the Supabase "rls_disabled_in_public" advisory (CutsCentral project).
--
-- The Security Advisor flags every table in the `public` schema that has RLS
-- disabled, because Supabase exposes a PostgREST data API reachable with the
-- anon/service API keys. Our app does NOT use that API (the browser never talks
-- to Supabase directly; we connect via Prisma as the `postgres` owner), but the
-- API endpoint exists regardless and would expose these tables if a key leaked
-- or the data API were ever enabled. Enabling RLS closes that hole.
--
-- The first RLS migration (20260607000000) covered the tenant tables
-- (Client, Visit, PunchLedger, Nudge). This migration covers the remaining
-- non-tenant tables: User, Shop, AcuityConnection.
--
-- These three are looked up by the trusted server (session->ownerId, magicToken,
-- webhookSecret) and are NOT per-shop. So we do NOT add a permissive policy:
-- with RLS enabled and no policy, the default is DENY for the anon/authenticated
-- API roles, while the `postgres` owner the app connects as BYPASSES RLS and
-- keeps full access. Net effect: app behaviour is unchanged; the data API is
-- locked out. FORCE is intentionally NOT used here so the owner keeps access.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is safe to re-run.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User', 'Shop', 'AcuityConnection']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END
$$;

-- Pin the search_path on the helper function to silence the
-- "function_search_path_mutable" advisory and prevent search_path hijacking.
-- (Re-declares the same body from migration 20260607000000.)
CREATE OR REPLACE FUNCTION current_shop_id() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('app.current_shop_id', true), '');
$$;
