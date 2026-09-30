import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import cron from "node-cron";
import { SCHEDULED_JOBS } from "./scheduler.js";

/**
 * 🔴 node-cron COUNTS A STEP FROM ZERO, NOT FROM THE START OF ITS RANGE.
 *
 * "15-59/30" reads, to anyone who knows cron, as :15 and :45. node-cron 3
 * expands the range to 15..59 and then keeps the values divisible by 30 -
 * just :30. So square-resync ran once an hour, at :30, head-to-head with
 * acuity-resync (the clash its offset existed to avoid), and
 * synced-visit-reminders ("10-59/20") ran at :20/:40 - on the native
 * reminder job's own ticks - instead of :10/:30/:50. Both looked right in
 * review and in the lease table; only the expansion shows it.
 *
 * So the schedule is checked the way node-cron itself will read it.
 */

const require = createRequire(import.meta.url);
// node-cron's own expander - the code that decides when a job fires. Not part
// of its typed API, hence the require; resolved from the package itself so a
// version bump that moves it fails here loudly rather than going stale.
const expand = require(
  path.join(path.dirname(require.resolve("node-cron")), "convert-expression"),
) as (expression: string) => string;

/** The minutes past the hour node-cron will fire at (it prepends seconds). */
function minutesOf(name: string): number[] {
  const job = SCHEDULED_JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`no scheduled job named ${name}`);
  return expand(job.cronExpr).split(" ")[1]!.split(",").map(Number);
}

describe("the scheduler's cron expressions, as node-cron reads them", () => {
  it("every expression is one node-cron accepts", () => {
    const invalid = SCHEDULED_JOBS.filter((j) => !cron.validate(j.cronExpr)).map((j) => j.name);
    expect(invalid).toEqual([]);
  });

  it("🔴 no job uses a stepped range ('a-b/n') - write the minutes out as a list", () => {
    const stepped = SCHEDULED_JOBS.filter((j) => /\d+-\d+\/\d+/.test(j.cronExpr)).map(
      (j) => `${j.name}: ${j.cronExpr}`,
    );
    expect(stepped).toEqual([]);
  });

  it("square-resync runs every half hour, off acuity-resync's ticks", () => {
    expect(minutesOf("square-resync")).toEqual([15, 45]);
    const clash = minutesOf("square-resync").filter((m) => minutesOf("acuity-resync").includes(m));
    expect(clash).toEqual([]);
  });

  it("synced-visit-reminders runs three times an hour, off the native reminder job's ticks", () => {
    expect(minutesOf("synced-visit-reminders")).toEqual([10, 30, 50]);
    const clash = minutesOf("synced-visit-reminders").filter((m) =>
      minutesOf("appointment-reminders").includes(m),
    );
    expect(clash).toEqual([]);
  });

  it("the expander really does read a stepped range from zero (the trap, pinned)", () => {
    expect(expand("15-59/30 * * * *").split(" ")[1]).toBe("30");
    expect(expand("10-59/20 * * * *").split(" ")[1]).toBe("20,40");
  });
});
