#!/usr/bin/env node
/**
 * GUARD FALSIFIER - the thing that would have caught 17 fake concurrency tests.
 *
 * A concurrency test is only worth anything if it FAILS when its guard is
 * removed. This script removes them, on purpose, and reports which tests
 * noticed. Anything that claims to test a race and stays green is theatre.
 *
 *   node scripts/falsify-guards.mjs            # every wave
 *   node scripts/falsify-guards.mjs --wave locks
 *   node scripts/falsify-guards.mjs --wave indexes
 *
 * It edits source files and drops indexes on the LOCAL TEST DATABASE, then puts
 * everything back with `git checkout` and `prisma migrate reset`. It refuses to
 * run against anything but localhost, and refuses to run with a dirty tree, so
 * a restore can never eat real work.
 *
 * Read the output as: "these tests noticed" is the good list. A race-shaped
 * test that is NOT in it is the finding.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TEST_DB = "postgresql://postgres:postgres@localhost:5432/chairback_test";

/** Guard removals, by wave. Each is a literal source substitution. */
const WAVES = {
  // Every pg_advisory_xact_lock becomes a no-op that is still valid SQL.
  locks: {
    kind: "source",
    find: "pg_advisory_xact_lock(hashtext(",
    replace: "length(md5(",
    where: "apps/api/src",
    skipTests: true,
  },
  // The partial/unique indexes that back "exactly one" claims.
  indexes: {
    kind: "index",
    drop: [
      "WalkInEntry_one_active_per_phone",
      "WaitlistOffer_one_active_per_slot",
      "WaitlistEntry_one_active_per_request",
      "PlatformOperation_one_active_per_kind",
      "AffiliateApplication_one_pending_per_shop",
      "AffiliateReferralAttribution_referredShopId_key",
      "AffiliateReward_referredShopId_key",
      "StripeWebhookEvent_eventId_key",
      "AffiliateQualifyingInvoice_stripeInvoiceId_key",
      "Shop_twilioNumber_key",
    ],
  },
};

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB, TEST_DATABASE_URL: TEST_DB },
    ...opts,
  });
}

function assertSafe() {
  const dirty = sh("git", ["status", "--porcelain"]).trim();
  if (dirty) {
    console.error("Refusing to run: the working tree is dirty.");
    console.error("This script edits source and restores with `git checkout`.");
    process.exit(1);
  }
  if (!TEST_DB.includes("localhost")) {
    console.error("Refusing to run: the test database is not localhost.");
    process.exit(1);
  }
}

function applySourceWave(wave) {
  const files = sh("git", ["grep", "-l", wave.find, "--", wave.where])
    .split("\n")
    .filter(Boolean)
    // 🔴 Never weaken a TEST file: several tests legitimately take the guard
    // themselves to build a barrier, and blunting those makes the whole run
    // meaningless (learned the hard way).
    .filter((f) => !wave.skipTests || !f.includes(".test."));
  let count = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    count += src.split(wave.find).length - 1;
    writeFileSync(f, src.split(wave.find).join(wave.replace));
  }
  console.log(`  weakened ${count} call site(s) across ${files.length} file(s)`);
  return files.length > 0;
}

function applyIndexWave(wave) {
  for (const idx of wave.drop) {
    sh("pnpm", [
      "--filter",
      "@chairback/db",
      "exec",
      "prisma",
      "db",
      "execute",
      "--stdin",
    ], { input: `DROP INDEX IF EXISTS "${idx}";` });
  }
  console.log(`  dropped ${wave.drop.length} index(es)`);
  return true;
}

function runSuite() {
  try {
    const out = sh("pnpm", ["--filter", "@chairback/api", "test"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  } catch (err) {
    // A failing suite is the EXPECTED outcome here.
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

function failedTests(output) {
  return [
    ...new Set(
      output
        .replace(/\[[0-9;]*m/g, "")
        .split("\n")
        .filter((l) => /^\s*×\s/.test(l))
        .map((l) => l.replace(/^\s*×\s*/, "").replace(/\s+\d+ms\s*$/, "").trim()),
    ),
  ];
}

function restore() {
  sh("git", ["checkout", "--", "."]);
  sh("pnpm", [
    "--filter",
    "@chairback/db",
    "exec",
    "prisma",
    "migrate",
    "reset",
    "--force",
    "--skip-seed",
    "--skip-generate",
  ]);
}

const only = process.argv.includes("--wave")
  ? process.argv[process.argv.indexOf("--wave") + 1]
  : null;

assertSafe();
const report = {};
for (const [name, wave] of Object.entries(WAVES)) {
  if (only && only !== name) continue;
  console.log(`\n=== wave: ${name} - removing the guard ===`);
  const applied = wave.kind === "source" ? applySourceWave(wave) : applyIndexWave(wave);
  if (!applied) {
    console.log("  nothing to remove; skipping");
    continue;
  }
  console.log("  running the API suite (this takes a few minutes)...");
  const noticed = failedTests(runSuite());
  report[name] = noticed;
  console.log(`  ${noticed.length} test(s) NOTICED the guard was gone:`);
  for (const t of noticed) console.log(`    ✓ ${t}`);
  console.log("  restoring...");
  restore();
}

console.log("\n================ SUMMARY ================");
for (const [wave, noticed] of Object.entries(report)) {
  console.log(`${wave}: ${noticed.length} test(s) failed when the guard was removed`);
}
console.log(
  "\nAny test whose NAME promises a race, a lock, a CAS or 'exactly one' and is\n" +
    "NOT listed above is not testing what it says. See apps/api/src/testing/\n" +
    "raceBarrier.ts for the shape that works.",
);
