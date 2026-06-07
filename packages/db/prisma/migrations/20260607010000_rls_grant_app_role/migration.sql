-- Allow the connecting role to SET ROLE chairback_app.
--
-- The app connects as the database owner (e.g. Supabase's `postgres`). To run
-- tenant transactions AS the RLS-subject role, the connecting role must be a
-- member of chairback_app. GRANT membership to whatever role the app uses.
--
-- We grant to the current user (the migration runner = the app's owner role) so
-- this works regardless of whether the role is named `postgres` or otherwise.
DO $$
DECLARE
  app_role text := current_user;
BEGIN
  EXECUTE format('GRANT chairback_app TO %I;', app_role);
EXCEPTION WHEN OTHERS THEN
  -- If already a member or insufficient privilege in a managed env, don't fail
  -- the migration; the app falls back to app-layer-only via DB_RLS_ENFORCE=false.
  RAISE NOTICE 'Could not grant chairback_app to %: %', app_role, SQLERRM;
END
$$;
