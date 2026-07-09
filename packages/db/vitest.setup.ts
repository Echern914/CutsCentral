/**
 * Load the repo-root .env into process.env before DB-backed tests run.
 * Vitest doesn't read .env automatically. Minimal parser - no extra dep.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  const envPath = resolve(process.cwd(), "../../.env");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // No .env (e.g. CI with env injected directly) - fine.
}

// These tests create and delete Users/Shops freely, so they must never run
// against a hosted (dev OR prod) database. Same stance as apps/api's setup:
// TEST_DATABASE_URL wins; without it, refuse anything that looks hosted.
// (2026-07-08: the missing guard let this suite write @test.local users into
// the dev Supabase project.)
const PROD_HOST_FRAGMENTS = ["supabase.co", "supabase.com"];
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testUrl;
} else {
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").host;
  } catch {
    // Unparseable/absent URL: let Prisma produce its own connection error.
  }
  if (PROD_HOST_FRAGMENTS.some((f) => host.includes(f))) {
    throw new Error(
      `Refusing to run @chairback/db tests against hosted database "${host}". ` +
        "Set TEST_DATABASE_URL to a disposable local database " +
        "(e.g. postgresql://postgres:postgres@localhost:5432/chairback_test).",
    );
  }
}
