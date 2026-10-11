import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { QUIET_HOURS, hourInTimeZone, isQuietHours } from "@chairback/config";

/**
 * 🔴 THE NUDGE AND WIN-BACK SWEEPS RUN AT EACH SHOP'S OWN MORNING.
 *
 * They used to be "0 10 * * *" and "0 11 * * *" with no timezone, which on
 * Railway is UTC: 3-7 AM across the US. The SMS leg was quiet-hours gated, so
 * it never texted anybody, and the push leg was not, so every nudge and
 * win-back that went out was a phone buzzing before dawn.
 *
 * Now both tick hourly and each tick sweeps only the shops whose own clock
 * reads the send hour. What is pinned here is the wiring the engine tests
 * cannot see: the cron really does tick every hour, the job really does pass
 * the hour, and that hour picks every zone exactly once a day, inside the
 * sending window.
 */

const calls = vi.hoisted(() => ({ nudge: [] as unknown[], winback: [] as unknown[] }));

vi.mock("./engines/nudge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engines/nudge.js")>();
  return {
    ...actual,
    runNudgeSweep: vi.fn(async (opts: unknown) => {
      calls.nudge.push(opts);
      return [];
    }),
  };
});
vi.mock("./engines/winback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engines/winback.js")>();
  return {
    ...actual,
    runWinbackSweep: vi.fn(async (opts: unknown) => {
      calls.winback.push(opts);
      return [];
    }),
  };
});

const { SCHEDULED_JOBS } = await import("./scheduler.js");
const { NUDGE_SEND_LOCAL_HOUR } = await import("./engines/nudge.js");
const { WINBACK_SEND_LOCAL_HOUR } = await import("./engines/winback.js");

const require = createRequire(import.meta.url);
// node-cron's own expander - the code that decides when a job fires (see
// scheduler.cron.test.ts for why the schedule is read this way).
const expand = require(
  path.join(path.dirname(require.resolve("node-cron")), "convert-expression"),
) as (expression: string) => string;

const job = (name: string) => {
  const j = SCHEDULED_JOBS.find((x) => x.name === name);
  if (!j) throw new Error(`no scheduled job named ${name}`);
  return j;
};
/** The hours of the day node-cron fires a job at. */
const hoursOf = (name: string) => expand(job(name).cronExpr).split(" ")[2]!.split(",").map(Number);
const EVERY_HOUR = Array.from({ length: 24 }, (_, h) => h);

describe("nudge + win-back sweeps run at shop-local hours", () => {
  it("🔴 both tick every hour of the day, not once at a UTC instant", () => {
    expect(hoursOf("nudge-sweep")).toEqual(EVERY_HOUR);
    expect(hoursOf("winback-sweep")).toEqual(EVERY_HOUR);
  });

  it("🔴 each tick asks for the shops at the send hour", async () => {
    await job("nudge-sweep").run();
    await job("winback-sweep").run();
    expect(calls.nudge).toEqual([{ localHour: NUDGE_SEND_LOCAL_HOUR }]);
    expect(calls.winback).toEqual([{ localHour: WINBACK_SEND_LOCAL_HOUR }]);
  });

  it("win-back comes an hour after the nudge, so it sees what is left of the daily cap", () => {
    expect(WINBACK_SEND_LOCAL_HOUR).toBe(NUDGE_SEND_LOCAL_HOUR + 1);
  });

  it.each([
    "America/New_York",
    "America/Los_Angeles",
    "Pacific/Honolulu",
    "Europe/London",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Pacific/Auckland",
  ])("%s is picked exactly once a day, inside sending hours, DST days included", (tz) => {
    // An ordinary day and both US clock changes of 2026.
    for (const day of ["2026-06-01", "2026-03-08", "2026-11-01"]) {
      for (const hour of [NUDGE_SEND_LOCAL_HOUR, WINBACK_SEND_LOCAL_HOUR]) {
        const ticks = EVERY_HOUR.map((h) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`)).filter(
          (t) => hourInTimeZone(t, tz) === hour,
        );
        expect(ticks).toHaveLength(1);
        expect(isQuietHours(ticks[0]!, tz, QUIET_HOURS.startHour, QUIET_HOURS.endHour)).toBe(false);
      }
    }
  });
});
