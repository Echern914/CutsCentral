/**
 * predev guardrail: refuse to start `pnpm dev` against the PRODUCTION database.
 *
 * Why: there is one Supabase project today and it is production. Local `pnpm dev`
 * connects to whatever DATABASE_URL is in .env, so a stale .env points your local
 * app at real customer data. The test suite is already protected
 * (apps/api/vitest.setup.ts), but `dev` was not. This closes that gap.
 *
 * How: read .env directly (no deps - this runs before the app loads anything),
 * and abort if DATABASE_URL/DIRECT_URL points at the known prod project ref.
 *
 * Fails OPEN by design: if .env is missing/unreadable or names no prod ref, dev
 * starts normally. It only fails CLOSED on a positive prod match, so it can never
 * lock you out of local dev. Override for a deliberate prod-pointed run with
 * ALLOW_PROD_DB=1.
 *
 * Once dev has its own Supabase project (see DB-SPLIT.md), this stays as a
 * belt-and-suspenders against a future stale .env.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The production Supabase project ref. If you migrate prod, update this.
const PROD_PROJECT_REF = "czqjnhwxcubnskyfamvb";

if (process.env.ALLOW_PROD_DB === "1") {
  process.exit(0); // explicit, deliberate opt-in - let it through
}

function readEnvFile() {
  // .env lives at repo root, one level up from /scripts.
  try {
    return readFileSync(resolve(__dirname, "..", ".env"), "utf8");
  } catch {
    return null; // no .env on disk (CI, or env injected directly) -> fail open
  }
}

function valueOf(raw, key) {
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    if (t.slice(0, eq).trim() !== key) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return "";
}

const raw = readEnvFile();
if (!raw) process.exit(0); // fail open

// process.env wins if it's already set (e.g. you exported a dev URL for this shell).
const dbUrl = process.env.DATABASE_URL || valueOf(raw, "DATABASE_URL");
const directUrl = process.env.DIRECT_URL || valueOf(raw, "DIRECT_URL");

const pointsAtProd = [dbUrl, directUrl].some(
  (u) => typeof u === "string" && u.includes(PROD_PROJECT_REF),
);

if (pointsAtProd) {
  console.error(
    "\n  REFUSING to start dev: DATABASE_URL/DIRECT_URL points at the PRODUCTION\n" +
      `  Supabase project (${PROD_PROJECT_REF}). Local dev would read/write real\n` +
      "  customer data.\n\n" +
      "  Point .env at your dev Supabase project (see DB-SPLIT.md), or, if you\n" +
      "  REALLY mean to run against prod, re-run with ALLOW_PROD_DB=1.\n",
  );
  process.exit(1);
}

process.exit(0);
