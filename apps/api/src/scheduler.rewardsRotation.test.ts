import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rotation worker's WIRING.
 *
 * The service accepts test-only knobs (`__testScope`, `batchSize`) so the
 * suites can traverse a single shop instead of the shared test database.
 * That convenience is exactly the thing that must never reach production: a
 * scope silently narrowing the corpus retirement would leave live credential
 * links behind and report success. So the scheduled job is pinned to call
 * the service with NO arguments at all.
 */

const processRotationRun = vi.hoisted(() =>
  vi.fn(async () => ({ runId: "run_1", rotated: 0, passHandled: 0, done: true })),
);
vi.mock("./services/rewardsRotation.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./services/rewardsRotation.js")>();
  return { ...real, processRotationRun };
});

import { SCHEDULED_JOBS } from "./scheduler.js";

beforeEach(() => processRotationRun.mockClear());

describe("the rewards-rotation job", () => {
  const job = () => SCHEDULED_JOBS.find((j) => j.name === "rewards-rotation");

  it("is scheduled, with a lease TTL that outlasts the worker's own budget", () => {
    expect(job()).toBeDefined();
    // The worker spends up to 60s per tick; a lease that expired mid-batch
    // would let a second replica run the same traversal.
    expect(job()!.ttlMs).toBeGreaterThan(60_000);
  });

  it("calls the service with NO arguments - never a scope, never a batch override", async () => {
    await job()!.run();
    expect(processRotationRun).toHaveBeenCalledTimes(1);
    expect(processRotationRun).toHaveBeenCalledWith();
  });

  it("starts no run of its own - only an admin POST creates one", async () => {
    // A null tick (the permanent steady state: no active run) must be a
    // quiet no-op, not an invitation to begin rotating.
    processRotationRun.mockResolvedValueOnce(null as never);
    await expect(job()!.run()).resolves.toBeUndefined();
  });
});
