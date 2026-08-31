/**
 * Regenerates `supportEvalBaseline.ts` from the current corpus and tools.
 *
 *   pnpm --filter @chairback/api exec tsx --env-file=../../.env src/support/regenerateBaseline.ts
 *
 * (the env file is only needed because importing the tool registry loads the
 * validated API env; the eval itself touches no service).
 *
 * Run this ONLY when a deliberate change moved the numbers — a corpus edit, a
 * matcher change, a tool-contract fix — and commit the regenerated file in the
 * same PR, so the diff shows exactly which fixtures moved and in which
 * direction. `supportEval.test.ts` failing against the committed baseline is
 * the mechanism working, not an inconvenience: it means support behavior
 * changed and someone must look at whether it changed for the better.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupportEval } from "./evalHarness.js";

const report = await runSupportEval();

const banner = `/**
 * GENERATED FILE — the honest baseline of what the two support channels do
 * with the eval fixtures TODAY. Regenerate with:
 *
 *   pnpm --filter @chairback/api exec tsx --env-file=../../.env src/support/regenerateBaseline.ts
 *
 * Never hand-edit a number to green a build: the whole point of this file is
 * that improvements and regressions both show up as a reviewed diff.
 */

import type { EvalReport } from "./evalHarness.js";

export const SUPPORT_EVAL_BASELINE: EvalReport = `;

const body = JSON.stringify(report, null, 2);
const out = `${banner}${body};\n`;

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "supportEvalBaseline.ts");
writeFileSync(target, out, "utf8");
console.log(`wrote ${target}`);
console.log(
  `in-app: ${JSON.stringify(report.inApp)}\nmcp:    ${JSON.stringify(report.mcp)}`,
);
