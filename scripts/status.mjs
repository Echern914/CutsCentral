#!/usr/bin/env node
/**
 * ChairBack status check — one command to answer "is prod up and is anything on fire?"
 *
 *   node scripts/status.mjs
 *
 * Read-only. Probes the live web + API, the nightly backup run, open PRs/issues,
 * and whether local main is behind origin. Prints a color-coded summary and exits
 * non-zero if anything critical is RED (so you can wire it into a cron/alert later).
 *
 * Needs: `gh` logged in (for PRs/issues/backup run) and network. Degrades gracefully
 * if `gh` is missing — the live probes still run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const WEB = "https://getchairback.com";
const API = "https://api.getchairback.com";
const SHOP_SLUG = "cherncuts"; // a live shop to prove the public booking API end-to-end

// --- tiny output helpers ------------------------------------------------------
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(90, s);
const bold = (s) => c(1, s);

const rows = [];
let hadCritical = false;
/** status: "ok" | "warn" | "fail"; critical=true means a fail should flip exit code. */
function record(label, status, detail, critical = false) {
  rows.push({ label, status, detail });
  if (status === "fail" && critical) hadCritical = true;
}

async function httpStatus(url, opts = {}) {
  // Use curl for portable HEAD/GET status + optional header/body capture.
  const args = ["-s", "-o", opts.body ? "-" : "/dev/null", "-w", "%{http_code}", "--max-time", "15", url];
  if (opts.head) args.splice(1, 0, "-I");
  try {
    const { stdout } = await exec("curl", args, { maxBuffer: 10 * 1024 * 1024 });
    if (opts.body) {
      // With -w the code is appended after the body; split it off.
      const code = stdout.slice(-3);
      return { code, body: stdout.slice(0, -3) };
    }
    return { code: stdout.trim(), body: "" };
  } catch (e) {
    return { code: "ERR", body: "", error: e.message };
  }
}

async function gh(args) {
  try {
    const { stdout } = await exec("gh", args, { maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, out: e.stdout || "", error: e.message };
  }
}

// --- checks -------------------------------------------------------------------
async function checkWeb() {
  const { code } = await httpStatus(WEB);
  if (code === "200") record("Web (getchairback.com)", "ok", "200");
  else record("Web (getchairback.com)", "fail", `HTTP ${code}`, true);
}

async function checkApi() {
  const { code } = await httpStatus(`${API}/healthz`, { body: true });
  if (code === "200") record("API /healthz", "ok", "200");
  else record("API /healthz", "fail", `HTTP ${code}`, true);
}

async function checkBookingApi() {
  const { code, body } = await httpStatus(`${API}/api/book/${SHOP_SLUG}`, { body: true });
  if (code !== "200") {
    record(`Public booking API (${SHOP_SLUG})`, "fail", `HTTP ${code}`, true);
    return;
  }
  try {
    const d = JSON.parse(body);
    const svc = (d.services || [])[0];
    const staff = (d.staff || [])[0];
    if (!svc || !staff) {
      record(`Public booking API (${SHOP_SLUG})`, "warn", "config OK but no service/staff to slot-check");
      return;
    }
    const slotsRes = await httpStatus(
      `${API}/api/book/${SHOP_SLUG}/slots?serviceId=${svc.id}&staffId=${staff.id}`,
      { body: true },
    );
    const slots = slotsRes.code === "200" ? (JSON.parse(slotsRes.body).slots || []) : [];
    record(`Public booking API (${SHOP_SLUG})`, "ok", `config 200, ${slots.length} open slots`);
  } catch {
    record(`Public booking API (${SHOP_SLUG})`, "warn", "200 but response not parseable");
  }
}

async function checkAttributionCookie() {
  const { body } = await httpStatus(`${WEB}/?utm_source=statuscheck&ref=statuscheck`, {
    head: true,
    body: true,
  });
  if (/cb_attn=/.test(body)) record("Attribution cookie (cb_attn)", "ok", "sets on UTM landing");
  else record("Attribution cookie (cb_attn)", "warn", "not observed — check middleware/deploy");
}

async function checkTrackingPixels() {
  // These SHOULD be dormant until you enable ads. If a pixel is live, flag it so
  // you remember the privacy policy must already reflect it.
  const { body } = await httpStatus(WEB, { body: true });
  const meta = /fbevents\.js|fbq\('init'/.test(body);
  const posthog = /posthog\.init/.test(body);
  if (!meta && !posthog) {
    record("Tracking pixels", "ok", "dormant (none loaded)");
  } else {
    const which = [meta && "Meta Pixel", posthog && "PostHog"].filter(Boolean).join(" + ");
    record("Tracking pixels", "warn", `${which} LIVE — confirm privacy policy discloses it`);
  }
}

async function checkBackup() {
  const res = await gh([
    "run", "list", "--workflow", "backup.yml", "--limit", "1",
    "--json", "conclusion,createdAt,event",
  ]);
  if (!res.ok) {
    record("Nightly R2 backup", "warn", "couldn't read (gh not available?)");
    return;
  }
  try {
    const [run] = JSON.parse(res.out);
    if (!run) return record("Nightly R2 backup", "warn", "no runs found");
    const when = run.createdAt.slice(0, 16).replace("T", " ") + "Z";
    const ageDays = (Date.now() - Date.parse(run.createdAt)) / 86400000;
    if (run.conclusion === "success") {
      const stale = ageDays > 1.6; // nightly — should never be >~1.5 days old
      record("Nightly R2 backup", stale ? "warn" : "ok",
        `last ${run.conclusion} ${when}${stale ? " (STALE — cron may have stopped)" : ""}`);
    } else {
      record("Nightly R2 backup", "fail", `last run ${run.conclusion} ${when}`, true);
    }
  } catch {
    record("Nightly R2 backup", "warn", "unparseable gh output");
  }
}

async function checkOpenWork() {
  const prs = await gh(["pr", "list", "--state", "open", "--json", "number"]);
  const issues = await gh(["issue", "list", "--state", "open", "--json", "number"]);
  if (prs.ok) {
    const n = JSON.parse(prs.out).length;
    record("Open PRs", n === 0 ? "ok" : "warn", n === 0 ? "none" : `${n} open`);
  }
  if (issues.ok) {
    const n = JSON.parse(issues.out).length;
    record("Open issues", n === 0 ? "ok" : "warn", n === 0 ? "none" : `${n} open`);
  }
}

async function checkLocalMain() {
  try {
    await exec("git", ["fetch", "origin", "--quiet"]);
    const { stdout: branch } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const { stdout: counts } = await exec("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
    const [behindLocal, behindRemote] = counts.trim().split(/\s+/).map(Number);
    // left = ahead of origin/main, right = behind origin/main
    const b = branch.trim();
    if (b !== "main") record("Local checkout", "warn", `on '${b}', not main`);
    else if (behindRemote > 0) record("Local main", "warn", `${behindRemote} commit(s) behind origin/main — pull`);
    else record("Local main", "ok", "up to date with origin/main");
  } catch (e) {
    record("Local git", "warn", "couldn't read git state");
  }
}

// --- run ----------------------------------------------------------------------
console.log(bold("\n  ChairBack status  ") + dim(new Date().toISOString()) + "\n");

await Promise.all([
  checkWeb(),
  checkApi(),
  checkBookingApi(),
  checkAttributionCookie(),
  checkTrackingPixels(),
  checkBackup(),
  checkOpenWork(),
  checkLocalMain(),
]);

const icon = { ok: green("✓"), warn: yellow("!"), fail: red("✗") };
const pad = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) {
  console.log(`  ${icon[r.status]}  ${r.label.padEnd(pad)}  ${dim(r.detail)}`);
}

const fails = rows.filter((r) => r.status === "fail").length;
const warns = rows.filter((r) => r.status === "warn").length;
console.log(
  "\n  " +
    (fails ? red(`${fails} failing`) : green("all live checks green")) +
    (warns ? yellow(`  ·  ${warns} to review`) : "") +
    "\n",
);
console.log(dim("  Full readiness checklist + open human tasks: docs/OPERATIONS.md\n"));

process.exit(hadCritical ? 1 : 0);
