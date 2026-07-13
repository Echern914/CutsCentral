/**
 * Test bootstrap. Loads env, then points the DB tests at a DEDICATED test
 * database - NEVER production.
 *
 * History: tests used to load the repo-root .env (the production Supabase URL)
 * and create throwaway `@test.local` shops directly in production. They piled
 * up and showed as fake data in the admin dashboard. This setup now hard-stops
 * that: tests run against TEST_DATABASE_URL, and if that is missing we refuse
 * to run against anything that looks like the production host.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load repo-root .env into process.env (without clobbering anything already set).
try {
  const raw = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // env injected directly (CI) - fine.
}

// Hosts that are NEVER allowed to be a test target. Tests create and delete
// shops freely, so they must run against a throwaway DB.
const PROD_HOST_FRAGMENTS = ["supabase.co", "supabase.com"];

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function looksLikeProd(url: string | undefined): boolean {
  const host = hostOf(url).toLowerCase();
  return PROD_HOST_FRAGMENTS.some((frag) => host.includes(frag));
}

// Prefer an explicit test database. This is the supported way to run DB tests.
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testUrl;
} else if (process.env.DIRECT_URL) {
  // No dedicated test DB configured - fall back to DIRECT_URL (legacy behavior),
  // but the prod guard below will stop us if that points at production.
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

// Billing must be OFF in the suite regardless of the local .env — CI runs with
// no STRIPE_* and the assertions assume the pre-revenue default (quota
// Infinity, trial reminders no-op); tests that exercise billing pass
// {enabled: true} explicitly. Without this, a developer who drops Stripe keys
// into .env to view the billing UI locally silently flips billingEnabled()
// and fails 20 unrelated engine tests (free-plan test shops get SMS quota 0).
for (const key of [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PREMIUM_AI_PRICE_ID",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_PLATFORM_WEBHOOK_SECRET",
]) {
  delete process.env[key];
}

// Hard stop: never let the suite touch a production database.
if (looksLikeProd(process.env.DATABASE_URL)) {
  throw new Error(
    "Refusing to run tests against a production database " +
      `(host "${hostOf(process.env.DATABASE_URL)}"). ` +
      "Set TEST_DATABASE_URL to a throwaway/local Postgres database and re-run. " +
      "See .env.example for setup.",
  );
}
