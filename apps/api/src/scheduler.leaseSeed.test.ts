import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SCHEDULED_JOBS } from "./scheduler.js";

/**
 * withLease() acquires by UPDATE-only, so a scheduled job whose name was never
 * seeded into job_lease by a migration silently never runs in ANY deployed
 * environment - while its own unit test (which inserts the row manually) stays
 * green. That is exactly how acuity-resync shipped dead. This test closes the
 * gap structurally: every name in SCHEDULED_JOBS must appear as a quoted
 * literal in some committed migration.
 */
describe("job_lease seed coverage", () => {
  it("every scheduled job name has a seed migration", () => {
    // vitest runs with cwd = apps/api (both via turbo and `pnpm --filter`).
    const migrationsDir = path.resolve(
      process.cwd(),
      "../../packages/db/prisma/migrations",
    );
    const allSql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        try {
          return readFileSync(path.join(migrationsDir, e.name, "migration.sql"), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");

    const missing = SCHEDULED_JOBS.map((j) => j.name).filter(
      (name) => !allSql.includes(`'${name}'`),
    );
    expect(missing, `unseeded job_lease names (job will NEVER run): ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("job names are unique", () => {
    const names = SCHEDULED_JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
