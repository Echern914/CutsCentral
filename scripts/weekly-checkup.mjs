#!/usr/bin/env node
/*
 * WEEKLY CHECKUP — your one-command health scan for CutsCentral.
 *
 * WHAT IT DOES (in plain English):
 *   Runs every mechanical audit you used to ask Claude for by hand:
 *     1. Git hygiene    — uncommitted work, unpushed commits, how far behind main you are
 *     2. TypeScript     — does each app (api / web / mobile) still compile?
 *     3. Lint           — code style problems per app
 *     4. Tests          — runs the API test suite
 *     5. Security       — known vulnerabilities in your dependencies
 *     6. Outdated deps  — packages with new major versions waiting
 *     7. Code smells    — leftover console.logs, TODO/FIXME notes, secrets in code
 *   Then writes a plain-English report to weekly-checkup-report.md.
 *
 * HOW TO RUN IT (from the repo folder — use the ~/dev clone, not Desktop):
 *   cd ~/dev/CutsCentral
 *   node scripts/weekly-checkup.mjs           full checkup
 *   node scripts/weekly-checkup.mjs --fast    skip the slow stuff (lint + tests)
 *   node scripts/weekly-checkup.mjs --ai      also have Claude do a deep bug scan
 *                                             of anything that failed + this branch's
 *                                             changes, and add it to the report
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FAST = process.argv.includes("--fast");
const AI = process.argv.includes("--ai");
const MAX_BUF = 32 * 1024 * 1024; // 32 MB of command output, plenty

// ---------- small helpers ----------------------------------------------------

function sh(cmd, args, { timeoutMin = 6, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMin * 60 * 1000,
    maxBuffer: MAX_BUF,
    input,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { ok: r.status === 0, out, stdout: (r.stdout || "").trim(), timedOut: r.error?.code === "ETIMEDOUT" };
}

// Figure out where the repo root is, so this works no matter where you run it from.
const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const ROOT = gitRoot.status === 0 ? gitRoot.stdout.trim() : process.cwd();

// pnpm might only be available through corepack — handle both.
const pnpmDirect = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
const PNPM = pnpmDirect.status === 0 ? ["pnpm"] : ["corepack", "pnpm"];
const pnpm = (args, opts) => sh(PNPM[0], [...PNPM.slice(1), ...args], opts);

// Trim long command output down to the interesting tail for the report.
const tail = (text, lines = 40) => {
  const all = (text || "").split("\n").filter(Boolean);
  return all.length <= lines ? all.join("\n") : `… (${all.length - lines} earlier lines hidden)\n${all.slice(-lines).join("\n")}`;
};

const results = []; // { name, status: 'pass'|'warn'|'fail'|'skip', headline, details, advice }
const add = (r) => {
  results.push(r);
  const icon = { pass: "✅", warn: "⚠️ ", fail: "❌", skip: "⏭️ " }[r.status];
  console.log(`${icon} ${r.name}: ${r.headline}`);
};

console.log(`\n🩺 Weekly checkup for ${ROOT}\n`);
if (ROOT.includes("/Desktop/")) {
  console.log(
    "⚠️  Heads up: this copy lives on your iCloud-synced Desktop. node_modules gets corrupted there,\n" +
      "   so typecheck/lint/test results can be wrong. For trustworthy results run:\n" +
      "   cd ~/dev/CutsCentral && git pull && node scripts/weekly-checkup.mjs\n"
  );
}

// ---------- 1. Git hygiene ---------------------------------------------------

{
  const branch = sh("git", ["branch", "--show-current"]).out || "(detached)";
  const dirty = sh("git", ["status", "--porcelain"]).out;
  const dirtyCount = dirty ? dirty.split("\n").length : 0;
  sh("git", ["fetch", "origin", "main", "--quiet"], { timeoutMin: 2 });
  const behind = sh("git", ["rev-list", "--count", `HEAD..origin/main`]).out || "0";
  const unpushed = sh("git", ["log", "--oneline", "@{u}..HEAD"], { timeoutMin: 1 });
  const unpushedCount = unpushed.ok && unpushed.out ? unpushed.out.split("\n").length : 0;

  const problems = [];
  if (dirtyCount > 0) problems.push(`${dirtyCount} file(s) with uncommitted changes`);
  if (Number(behind) > 0) problems.push(`this branch is ${behind} commit(s) behind main`);
  if (unpushedCount > 0) problems.push(`${unpushedCount} commit(s) not pushed to GitHub yet`);

  add({
    name: "Git hygiene",
    status: problems.length ? "warn" : "pass",
    headline: problems.length ? `on "${branch}" — ${problems.join(", ")}` : `on "${branch}" — everything committed, pushed, and up to date with main`,
    details: dirty ? `Uncommitted files:\n${tail(dirty, 20)}` : "",
    advice: problems.length
      ? "Commit or stash loose work, push your branch, and merge main in if you're behind — unmerged work is where regressions hide."
      : "",
  });
}

// ---------- 2. TypeScript, per app -------------------------------------------

const APPS = ["@chairback/api", "@chairback/web", "@chairback/mobile"];
for (const app of APPS) {
  const short = app.split("/")[1];
  const r = pnpm(["--filter", app, "typecheck"], { timeoutMin: 8 });
  const errCount = (r.out.match(/error TS\d+/g) || []).length;
  add({
    name: `TypeScript (${short})`,
    status: r.ok ? "pass" : "fail",
    headline: r.ok ? "compiles cleanly" : r.timedOut ? "timed out" : `${errCount || "some"} type error(s)`,
    details: r.ok ? "" : tail(r.out),
    advice: r.ok ? "" : `Type errors mean this code may crash or misbehave. Run with --ai, or paste the ${short} section of the report into Claude and ask for fixes.`,
  });
}

// ---------- 3. Lint, per app (skipped with --fast) ----------------------------

for (const app of APPS) {
  const short = app.split("/")[1];
  if (FAST) {
    add({ name: `Lint (${short})`, status: "skip", headline: "skipped (--fast)", details: "", advice: "" });
    continue;
  }
  const r = pnpm(["--filter", app, "lint"], { timeoutMin: 8 });
  add({
    name: `Lint (${short})`,
    status: r.ok ? "pass" : "warn",
    headline: r.ok ? "no style problems" : r.timedOut ? "timed out" : "found problems",
    details: r.ok ? "" : tail(r.out),
    advice: r.ok ? "" : "Lint findings are usually quick fixes — many auto-fix with the app's lint --fix command.",
  });
}

// ---------- 4. Tests (API has the test suite; skipped with --fast) ------------

if (FAST) {
  add({ name: "Tests (api)", status: "skip", headline: "skipped (--fast)", details: "", advice: "" });
} else {
  const r = pnpm(["--filter", "@chairback/api", "test"], { timeoutMin: 10 });
  const failLine = r.out.split("\n").find((l) => /failed/i.test(l)) || "";
  add({
    name: "Tests (api)",
    status: r.ok ? "pass" : "fail",
    headline: r.ok ? "all tests passing" : r.timedOut ? "timed out" : failLine.trim() || "tests failing",
    details: r.ok ? "" : tail(r.out, 60),
    advice: r.ok ? "" : "A failing test means something that used to work probably broke. Fix this before shipping anything.",
  });
}

// ---------- 5. Security audit of dependencies ---------------------------------

{
  const r = pnpm(["audit", "--prod", "--json"], { timeoutMin: 4 });
  let counts = null;
  try {
    // pnpm mixes warnings in with the JSON — parse only the JSON part of stdout.
    const json = r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1);
    counts = JSON.parse(json).metadata?.vulnerabilities;
  } catch {}
  if (counts) {
    const serious = (counts.critical || 0) + (counts.high || 0);
    const minor = (counts.moderate || 0) + (counts.low || 0);
    add({
      name: "Security (dependencies)",
      status: serious ? "fail" : minor ? "warn" : "pass",
      headline: serious
        ? `${serious} serious vulnerability(ies) (${counts.critical || 0} critical, ${counts.high || 0} high)`
        : minor
          ? `${minor} minor vulnerability(ies) — no urgent risk`
          : "no known vulnerabilities",
      details: "",
      advice: serious ? "Run `pnpm audit --prod` for details, then update the flagged packages. Critical/high ones matter for a real customer app." : "",
    });
  } else {
    add({ name: "Security (dependencies)", status: "warn", headline: "couldn't read audit results", details: tail(r.out, 10), advice: "" });
  }
}

// ---------- 6. Outdated packages ----------------------------------------------

{
  const r = pnpm(["-r", "outdated"], { timeoutMin: 4 });
  // pnpm exits non-zero when anything is outdated; empty output means all current.
  const hasRows = /\d+\.\d+/.test(r.out);
  add({
    name: "Outdated packages",
    status: hasRows ? "warn" : "pass",
    headline: hasRows ? "some packages have newer versions" : "everything up to date",
    details: hasRows ? tail(r.out, 30) : "",
    advice: hasRows ? "Not urgent. Once a month, update a few at a time and re-run this checkup after." : "",
  });
}

// ---------- 7. Code smells: debug logs, TODOs, secrets -------------------------

{
  const logs = sh("git", ["grep", "-n", "console.log", "--", "apps/api/src", "apps/web/src"]);
  const logCount = logs.out ? logs.out.split("\n").length : 0;
  const todos = sh("git", ["grep", "-inE", "TODO|FIXME|HACK", "--", "apps", "packages"]);
  const todoCount = todos.out ? todos.out.split("\n").length : 0;
  const secrets = sh("git", [
    "grep", "-nE",
    "(sk_live_|sk_test_|AKIA[0-9A-Z]{16}|-----BEGIN[ A-Z]*PRIVATE KEY|xox[bap]-)",
    "--", ".", ":!pnpm-lock.yaml", ":!*.md", ":!*.test.ts", ":!.env.example",
  ]);
  const secretCount = secrets.out ? secrets.out.split("\n").length : 0;

  add({
    name: "Code smells",
    status: secretCount ? "fail" : logCount > 15 ? "warn" : "pass",
    headline: secretCount
      ? `possible SECRETS committed to code (${secretCount} match(es)) — check these first`
      : `${logCount} console.log(s) in server/web code, ${todoCount} TODO/FIXME note(s)`,
    details: [
      secretCount ? `Possible secrets:\n${tail(secrets.out, 15)}` : "",
      logCount ? `console.logs:\n${tail(logs.out, 15)}` : "",
    ].filter(Boolean).join("\n\n"),
    advice: secretCount
      ? "If any of these are real keys, rotate them (get new ones) — anything committed to git history should be treated as leaked."
      : logCount > 15
        ? "Lots of console.logs in production code can leak data into logs and slow things down. Prune them when convenient."
        : "",
  });
}

// ---------- Write the report ---------------------------------------------------

const icon = { pass: "✅", warn: "⚠️", fail: "❌", skip: "⏭️" };
const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
results.forEach((r) => counts[r.status]++);

const verdict = counts.fail
  ? `❌ ${counts.fail} thing(s) are broken and need attention.`
  : counts.warn
    ? `⚠️ Nothing is broken, but ${counts.warn} thing(s) could use cleanup.`
    : `✅ Clean bill of health. Ship away.`;

let report = `# Weekly Checkup Report

**Verdict: ${verdict}**

| Check | Result |
|---|---|
${results.map((r) => `| ${r.name} | ${icon[r.status]} ${r.headline} |`).join("\n")}

## Details
${results
  .filter((r) => r.details || r.advice)
  .map((r) => `### ${icon[r.status]} ${r.name}\n${r.advice ? `**What to do:** ${r.advice}\n` : ""}${r.details ? `\n\`\`\`\n${r.details}\n\`\`\`` : ""}`)
  .join("\n\n") || "_Nothing needed a closer look. Nice._"}
`;

// ---------- Optional: hand the judgment work to Claude (--ai) -------------------

if (AI) {
  console.log("\n🤖 Asking Claude for a deep bug scan (this takes a few minutes)…");
  const diffStat = sh("git", ["diff", "origin/main...HEAD", "--stat"]).out;
  const failures = results
    .filter((r) => r.status === "fail" || r.status === "warn")
    .map((r) => `## ${r.name}: ${r.headline}\n${r.details}`)
    .join("\n\n");
  const prompt = `You are auditing the CutsCentral monorepo (barber shop app: Expo mobile app, Next.js web, Node API, Prisma DB). You have read access to the repo at ${ROOT}.

Here are this week's automated check results that failed or warned:
${failures || "(all mechanical checks passed)"}

Here is what changed on the current branch vs main:
${diffStat || "(no diff vs main)"}

Do a focused bug scan: read the changed files and any files implicated by the failures above. Report only REAL problems — bugs that would affect users, security issues, or broken logic. Skip style nitpicks (lint already ran). For each finding give: severity, file:line, what's wrong in one sentence, and how to fix it in one sentence. If you find nothing real, say so plainly. End with a one-paragraph plain-English summary for a non-engineer.`;

  const ai = sh("claude", ["-p"], { input: prompt, timeoutMin: 15 });
  report += `\n## 🤖 Claude's Deep Bug Scan\n\n${ai.ok ? ai.out : `Claude scan failed:\n\`\`\`\n${tail(ai.out, 20)}\n\`\`\``}\n`;
  console.log(ai.ok ? "🤖 Done — findings added to the report." : "🤖 Claude scan failed — see report for the error.");
}

const reportPath = join(ROOT, "weekly-checkup-report.md");
writeFileSync(reportPath, report);

console.log(`\n${verdict}`);
console.log(`📄 Full report: ${reportPath}\n`);
process.exit(counts.fail ? 1 : 0);
