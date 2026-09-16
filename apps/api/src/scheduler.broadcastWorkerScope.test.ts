import { describe, expect, it, vi } from "vitest";

vi.mock("./engines/broadcastWorker.js", () => ({
  runBroadcastWorker: vi.fn(async () => ({
    claimed: 0,
    sent: 0,
    retry: 0,
    failed: 0,
    abandoned: 0,
    skipped: 0,
    staleClaim: 0,
    finalized: 0,
  })),
}));

import { runBroadcastWorker } from "./engines/broadcastWorker.js";
import { SCHEDULED_JOBS } from "./scheduler.js";

/**
 * 🔴 runBroadcastWorker takes a `shopId` so tests can keep to their own rows.
 * Production must never pass one: a scoped worker drains a single shop, and
 * every other shop's blast would sit QUEUED forever with nothing to deliver it.
 */
describe("the scheduled broadcast worker", () => {
  it("drains every shop - the test-only scope never reaches production", async () => {
    const job = SCHEDULED_JOBS.find((j) => j.name === "broadcast-worker");
    expect(job, "the broadcast-worker job is registered").toBeTruthy();

    await job!.run();

    expect(runBroadcastWorker).toHaveBeenCalledOnce();
    expect(vi.mocked(runBroadcastWorker).mock.calls[0]).toEqual([]);
  });
});
