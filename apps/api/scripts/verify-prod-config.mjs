/**
 * Verify production database configuration — READ ONLY, changes nothing.
 *
 * Turns "it should be configured right" into "I confirmed it" for the two
 * settings that actually protect you and keep you up:
 *
 *   1. Connection pool size — your #1 scaling bottleneck. At connection_limit=1
 *      every API request serializes behind every other one; the app gets slow
 *      then falls over under real load. Prod should run a real pool (>=10).
 *      We read the limit from the DATABASE_URL and ALSO ask Postgres how many
 *      connections this app role is actually allowed / currently using.
 *
 *   2. Row-Level Security (RLS) — your defense-in-depth tenant isolation only
 *      protects you if it's actually ENABLED on the tenant tables in this exact
 *      database. We ask Postgres directly which tables have RLS on, rather than
 *      trusting the DB_RLS_ENFORCE env flag.
 *
 * This script opens ONE connection, runs a handful of SELECTs against Postgres
 * catalog views, prints a report, and exits. It never writes.
 *
 * Run:  node apps/api/scripts/verify-prod-config.mjs
 *       (loads .env from repo root via dotenv, same as the other scripts)
 */
import { config } from "dotenv";
config();

import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

// Tenant tables that MUST have RLS enabled (the per-shop data). Mirrors the
// tables scoped through forShop() in packages/db/src/tenant.ts.
const TENANT_TABLES = [
  "Client",
  "Visit",
  "PunchLedger",
  "Nudge",
  "Reward",
  "EarnRule",
  "Promotion",
  "PromotionRedemption",
  "AppointmentRequest",
  "Review",
];

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

function connectionLimitOf(url) {
  try {
    const v = new URL(url).searchParams.get("connection_limit");
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

// The connection_limit that actually matters in prod lives on the POOLED url the
// Railway process runs with (Supabase pooler: "pooler" host / port 6543). When
// this script is run locally it's almost always pointed at the DIRECT url (5432,
// no pool param) - reading connection_limit there tells you nothing about the
// deployed pool and would false-warn every run. So only grade the pool when the
// url IS the pooled one (or the operator explicitly opts in via CHECK_POOL=1).
function isPooledUrl(url) {
  try {
    const u = new URL(url);
    return u.port === "6543" || u.host.includes("pooler");
  } catch {
    return false;
  }
}

const prisma = new PrismaClient();
let problems = 0;

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}
function warn(msg) {
  console.log(`  ⚠️  ${msg}`);
  problems++;
}
function fail(msg) {
  console.log(`  ❌ ${msg}`);
  problems++;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  console.log(`\nVerifying database: ${hostOf(dbUrl)}\n`);

  // ---- 1. Connection pool ----------------------------------------------
  console.log("1) Connection pool");
  const checkPool = isPooledUrl(dbUrl) || process.env.CHECK_POOL === "1";
  const limit = connectionLimitOf(dbUrl);
  if (!checkPool) {
    // Not the deployed pooled url - grading connection_limit here is meaningless
    // (and the role cap below already shows what Postgres allows). Skip cleanly
    // instead of false-warning.
    console.log(
      "  ⏭️  skipped — this isn't the pooled DATABASE_URL the app runs with. " +
        "To check the deployed pool size, run with the Railway pooler URL " +
        "(or CHECK_POOL=1 to force).",
    );
  } else if (limit === null) {
    warn(
      "Pooled DATABASE_URL has no connection_limit param. Prisma defaults to (num_cpus*2+1), " +
        "which is often just 1-3 on a small host. Set ?connection_limit=10 explicitly.",
    );
  } else if (limit < 10) {
    fail(
      `connection_limit=${limit} — too small. At low values requests serialize. ` +
        "Set ?connection_limit=10 (or higher) on the prod DATABASE_URL.",
    );
  } else if (limit > 25) {
    // Too HIGH is its own hazard: per-replica limit x replicas must stay under
    // the Supabase pooler "Pool Size" budget (often ~15 on smaller tiers). A
    // value like 100 doesn't buy more throughput — it overruns the pooler and
    // connections start getting refused under load. 10 is the recommended base.
    warn(
      `connection_limit=${limit} — suspiciously high. (per-replica limit x replicas) ` +
        "must stay under the Supabase pooler Pool Size. 10 is the recommended base; " +
        "only raise toward ~20 if you actually observe request queueing.",
    );
  } else {
    pass(`connection_limit=${limit} (a real pool)`);
  }

  // What Postgres itself thinks this role is allowed / using right now.
  const [{ rolconnlimit }] = await prisma.$queryRawUnsafe(
    "SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user",
  );
  const active = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = current_user",
  );
  console.log(
    `     (role cap: ${rolconnlimit === -1 ? "unlimited" : rolconnlimit}, ` +
      `currently open: ${active[0].n})`,
  );

  // ---- 2. Row-Level Security -------------------------------------------
  console.log("\n2) Row-Level Security on tenant tables");
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    TENANT_TABLES,
  );
  const byName = new Map(rows.map((r) => [r.table, r]));
  for (const t of TENANT_TABLES) {
    const r = byName.get(t);
    if (!r) {
      warn(`${t}: table not found (schema drift?)`);
    } else if (r.enabled) {
      pass(`${t}: RLS enabled${r.forced ? " + forced" : ""}`);
    } else {
      fail(`${t}: RLS DISABLED — tenant rows are not protected at the DB layer`);
    }
  }

  // DB_RLS_ENFORCE flag (the app-side switch that makes forShop set the role).
  console.log("\n3) App flag");
  const flag = process.env.DB_RLS_ENFORCE;
  if (flag === "false" || flag === "0") {
    fail("DB_RLS_ENFORCE is off — the app won't switch to the RLS-bound role.");
  } else {
    pass(`DB_RLS_ENFORCE=${flag ?? "(default true)"}`);
  }

  console.log(
    `\n${problems === 0 ? "✅ All checks passed." : `⚠️  ${problems} item(s) need attention (see above).`}\n`,
  );
}

main()
  .catch((e) => {
    console.error("verify-prod-config failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
