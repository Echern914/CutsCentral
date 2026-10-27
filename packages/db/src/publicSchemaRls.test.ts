import { describe, expect, it } from "vitest";
import { prisma } from "./client.js";

/**
 * Every table in "public" has row-level security ENABLED - Prisma's own
 * _prisma_migrations included.
 *
 * On Supabase every table in "public" is reachable through the REST API
 * (PostgREST) with the project's anon key, and Supabase's Security Advisor
 * mails a CRITICAL "Table publicly accessible" for any table without RLS.
 * _prisma_migrations was the one left (2026-10-27): the API roles could
 * read, edit, delete and TRUNCATE it. A new table that forgets
 * `ENABLE ROW LEVEL SECURITY` fails here, in the suite, instead of in an
 * email after it ships.
 */
describe("public schema", () => {
  it("has RLS enabled on every table", async () => {
    const off = await prisma.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
        ORDER BY 1`,
    );
    expect(off.map((r) => r.relname)).toEqual([]);
  });

  it("gives the app role nothing on _prisma_migrations", async () => {
    const grants = await prisma.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
          AND grantee = 'chairback_app'`,
    );
    expect(grants).toEqual([]);
  });
});
