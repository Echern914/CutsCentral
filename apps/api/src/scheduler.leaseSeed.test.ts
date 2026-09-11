import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { prisma } from "@chairback/db";
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

  /**
   * The same check verifyLeaseRows() makes at startup, made here against a
   * database the migrations have actually been applied to.
   *
   * The structural test above proves a seed line was WRITTEN. This one proves
   * it LANDED - a migration whose INSERT silently matched nothing (a renamed
   * column, an ON CONFLICT that swallowed more than intended) would pass the
   * first and fail this.
   */
  it("every scheduled job has a real job_lease row in the database", async () => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT "name" FROM "job_lease"`;
    const seeded = new Set(rows.map((r) => r.name));
    const missing = SCHEDULED_JOBS.map((j) => j.name).filter((n) => !seeded.has(n));
    expect(missing, `job_lease rows missing (these jobs would NEVER run): ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("the broadcast worker is scheduled, not just seeded", () => {
    // A lease with no job behind it is as dead as a job with no lease, and the
    // broadcast worker is the ONLY thing that delivers a queued blast: without
    // it, every send answers 202 and nothing ever leaves.
    const job = SCHEDULED_JOBS.find((j) => j.name === "broadcast-worker");
    expect(job, "broadcast-worker is not in SCHEDULED_JOBS").toBeDefined();
    expect(job!.cronExpr).toBe("* * * * *");
    // The TTL must comfortably exceed one pass, or a second replica could
    // start claiming rows this one still holds.
    expect(job!.ttlMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
