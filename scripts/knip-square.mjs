#!/usr/bin/env node
/**
 * Unused-export gate for the Square outbound path.
 *
 * WHY THIS EXISTS. `isSquareSellerNote` was written, unit-tested, exported -
 * and called from nowhere in production. It was also exactly the helper needed
 * to stop the mirror importing its own booking as a duplicate appointment. A
 * manual sweep found it; a manual sweep is not a control.
 *
 * TWO MODES, on purpose:
 *
 *   GATE (exit 1)  - exports used NOWHERE, not even inside their own file.
 *                    That is the `isSquareSellerNote` shape: real logic that
 *                    silently does not run.
 *   REPORT (exit 0) - exports used only INSIDE their own module. Not broken,
 *                    but they are why the real case was invisible: when
 *                    everything is exported, "exported and never called" stops
 *                    being a signal. Printed so the number is visible and can
 *                    be brought down deliberately, not fixed under a red CI.
 *
 * Scoped to Square because that is the path under active construction. knip
 * analyses the WHOLE api workspace - it has to, or it cannot see the consumers -
 * and only the Square findings decide the exit code.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCOPE = /(^|\/)(square|Square)|mirrorNotConfigured/;

/**
 * knip's own JS entry, run through THIS node - never `npx`.
 *
 * 🔴 `execFileSync("npx.cmd", ...)` fails with EINVAL on Node 24 / Windows,
 * which spawnSync reports as a caught error with EMPTY stdout. Swallowing that
 * made the gate print "no unreferenced exports" while having run nothing at
 * all: a CI check that can only ever pass is worse than no CI check, because
 * it is believed.
 */
const KNIP_BIN = fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url));

function knip(extraArgs) {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [KNIP_BIN, "--include", "exports,types", "--reporter", "json", ...extraArgs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    // knip exits non-zero when it FINDS something; the JSON is still on stdout.
    out = err.stdout ?? "";
    if (!out.includes("{")) {
      console.error("knip failed to run:", err.stderr || err.message);
      process.exit(2);
    }
  }
  if (!out.includes("{")) {
    console.error("knip produced no JSON - refusing to report a pass it did not earn.");
    process.exit(2);
  }
  return out;
}

function findings(raw) {
  const start = raw.indexOf("{");
  if (start < 0) return [];
  let data;
  try {
    data = JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
  const out = [];
  for (const issue of data.issues ?? []) {
    const file = issue.file ?? "";
    if (!SCOPE.test(file)) continue;
    for (const kind of ["exports", "types"]) {
      for (const e of issue[kind] ?? []) out.push({ file, name: e.name, kind });
    }
  }
  return out;
}

const gate = findings(knip([]));

// The REPORT pass needs ignoreExportsUsedInFile OFF, which is a CONFIG option
// and not a CLI flag - passing it as a flag makes knip exit with "Unknown
// option", which a swallowed stderr would turn into a silent empty report.
const REPORT_CONFIG = "knip.report.tmp.json";
const base = JSON.parse(readFileSync("knip.json", "utf8"));
writeFileSync(REPORT_CONFIG, JSON.stringify({ ...base, ignoreExportsUsedInFile: false }, null, 2));
let all;
try {
  all = findings(knip(["--config", REPORT_CONFIG]));
} finally {
  rmSync(REPORT_CONFIG, { force: true });
}
const internalOnly = all.filter((a) => !gate.some((g) => g.name === a.name && g.file === a.file));

if (internalOnly.length) {
  console.log(`\nREPORT - exported but used only inside their own module (${internalOnly.length}):`);
  for (const f of internalOnly) console.log(`  ${f.kind}: ${f.name}  <- ${f.file}`);
  console.log("  Not a failure. Narrowing these to module-private would make the");
  console.log("  next genuinely-dead export show up as an unused-symbol warning.");
}

if (gate.length) {
  console.error(`\nFAIL - Square exports with NO call site anywhere (${gate.length}):`);
  for (const f of gate) console.error(`  ${f.kind}: ${f.name}  <- ${f.file}`);
  console.error("\n  Either wire it up or delete it. An export nothing calls is either");
  console.error("  dead weight or - as isSquareSellerNote was - a bug that never ran.");
  process.exit(1);
}

console.log("\nOK - no unreferenced Square exports.");
