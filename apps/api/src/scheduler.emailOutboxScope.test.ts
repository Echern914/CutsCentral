import { describe, expect, it, vi } from "vitest";

vi.mock("./engines/emailOutbox.js", () => ({
  runEmailOutbox: vi.fn(async () => ({
    claimed: 0,
    sent: 0,
    retry: 0,
    abandoned: 0,
    suppressed: 0,
    superseded: 0,
    staleClaim: 0,
  })),
}));

import { runEmailOutbox } from "./engines/emailOutbox.js";
import { SCHEDULED_JOBS } from "./scheduler.js";

/**
 * 🔴 runEmailOutbox takes a `shopId` so tests can keep to their own rows.
 * Production must never pass one: a scoped drain sends a single shop's email,
 * and every other shop's cancellations and receipts would sit PENDING forever.
 */
describe("the scheduled email outbox", () => {
  it("drains every shop - the test-only scope never reaches production", async () => {
    const job = SCHEDULED_JOBS.find((j) => j.name === "email-outbox");
    expect(job, "the email-outbox job is registered").toBeTruthy();

    await job!.run();

    expect(runEmailOutbox).toHaveBeenCalledOnce();
    expect(vi.mocked(runEmailOutbox).mock.calls[0]).toEqual([]);
  });
});
