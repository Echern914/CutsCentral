import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rebook-nudges job's WIRING. It now carries three steps on one lease:
 * the rebook push, the "Leave a tip" sweep and the paid-tip self-heal.
 *
 *  - Each step is called with NO arguments: the sweeps' scope options exist
 *    for the suites, and a scope reaching production would silently skip
 *    every shop outside it.
 *  - One step failing never skips the others, and each failure reaches
 *    Sentry on its own - a cron job has no user to complain.
 */

const m = vi.hoisted(() => ({
  runRebookNudges: vi.fn(async () => 0),
  runTipRequestSweep: vi.fn(async () => 0),
  repairUnannouncedTips: vi.fn(async () => 0),
  captureError: vi.fn(),
}));
vi.mock("./engines/rebookNudges.js", () => ({ runRebookNudges: m.runRebookNudges }));
vi.mock("./engines/tipRequests.js", () => ({
  runTipRequestSweep: m.runTipRequestSweep,
  repairUnannouncedTips: m.repairUnannouncedTips,
}));
vi.mock("./sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sentry.js")>()),
  captureError: m.captureError,
}));

import { SCHEDULED_JOBS } from "./scheduler.js";

const job = () => SCHEDULED_JOBS.find((j) => j.name === "rebook-nudges")!;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.runRebookNudges.mockResolvedValue(0);
  m.runTipRequestSweep.mockResolvedValue(0);
  m.repairUnannouncedTips.mockResolvedValue(0);
});

describe("the after-visit job", () => {
  it("runs all three steps, each with NO arguments", async () => {
    expect(job().cronExpr).toBe("*/10 * * * *");
    await job().run();
    for (const step of [m.runRebookNudges, m.runTipRequestSweep, m.repairUnannouncedTips]) {
      expect(step).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith();
    }
  });

  it("🔴 any one step throwing still runs the others, and is reported on its own", async () => {
    const steps = [
      ["rebook-nudges", m.runRebookNudges],
      ["tip-requests", m.runTipRequestSweep],
      ["tip-announce-repair", m.repairUnannouncedTips],
    ] as const;
    for (const [name, broken] of steps) {
      for (const [, fn] of steps) {
        fn.mockReset();
        fn.mockResolvedValue(0);
      }
      m.captureError.mockReset();
      const boom = new Error(`${name} broke`);
      broken.mockRejectedValueOnce(boom);

      await expect(job().run()).resolves.toBeUndefined();
      for (const [, fn] of steps) expect(fn, name).toHaveBeenCalledTimes(1);
      expect(m.captureError, name).toHaveBeenCalledTimes(1);
      expect(m.captureError, name).toHaveBeenCalledWith(boom, { job: "rebook-nudges", step: name });
    }
  });
});
