/**
 * Loads the repo-root .env into process.env. MUST be imported FIRST in the entry
 * point, before any module that reads env at import time (e.g. logger → apiEnv).
 *
 * Looks for .env at the monorepo root regardless of where the process is started.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Walk up to find the repo root .env (works from src/ or dist/).
const candidates = [
  resolve(here, "../../../.env"), // apps/api/src or apps/api/dist → repo root
  resolve(here, "../../../../.env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
];
for (const path of candidates) {
  if (existsSync(path)) {
    config({ path });
    break;
  }
}
