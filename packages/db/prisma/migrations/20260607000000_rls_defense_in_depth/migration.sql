-- RLS defense-in-depth for tenant tables.
--
-- The app connects as a NON-OWNER role (chairback_app) so these policies are
-- actually enforced (the owner/superuser role bypasses RLS). Each tenant query
-- runs inside a transaction that sets app.current_shop_id; policies restrict
-- rows to that shop. This is a SECOND layer — forShop() already scopes queries
-- at the application level.
--
-- Idempotent where practical so it can be re-applied safely.

-- 1) Application role (no LOGIN here; the connection role/password is managed in
--    Supabase. If you connect via a dedicated DB user, GRANT it this role.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chairback_app') THEN
    CREATE ROLE chairback_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chairback_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chairback_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chairback_app;

-- Helper: the current shop id from the transaction-local setting (NULL if unset).
CREATE OR REPLACE FUNCTION current_shop_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_shop_id', true), '');
$$ LANGUAGE sql STABLE;

-- 2) Enable RLS + per-shop policies on every tenant-owned table.
--    FORCE so even the table owner is subject to policies in app sessions that
--    SET ROLE chairback_app (defense-in-depth).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Client', 'Visit', 'PunchLedger', 'Nudge']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;

-- NOTE: Shop, User, AcuityConnection are NOT under per-shop RLS — they are
-- looked up by the API as the trusted server (session→ownerId, magicToken,
-- webhookSecret). They remain protected by the non-owner GRANTs above.
