/* LOCK _prisma_migrations: the last table in "public" with RLS off.

   Supabase's Security Advisor flags it (rls_disabled_in_public): every table
   in "public" is exposed through Supabase's REST API (PostgREST), and on
   Supabase the API roles "anon" and "authenticated" hold full privileges on
   this table - read, edit, delete, TRUNCATE. ChairBack never uses that API,
   but anyone holding the project's anon key could have rewritten or emptied
   the record of which migrations are applied. No customer data lives here.

   Why this is safe for Prisma itself: migrations connect as "postgres" (the
   session pooler, user postgres.<ref>), which OWNS this table and has
   BYPASSRLS. RLS is ENABLED, not FORCED, so the owner is unaffected either
   way; Prisma writes this migration's own row right after running it.

   The app role never reads it (no code does), so it loses its grants too.
   "anon" / "authenticated" exist only on Supabase - the local and CI test
   databases are plain Postgres - hence the existence checks. */

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'chairback_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "_prisma_migrations" FROM %I', r);
    END IF;
  END LOOP;
END $$;

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
