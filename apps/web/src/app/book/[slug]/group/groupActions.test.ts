import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 A GROUP CREATE WHOSE ANSWER NEVER CAME IS "network", NOT "error".
 *
 * apiPublicSend never throws: doFetch turns a timeout, abort or dropped
 * connection into `{ ok: false, status: 0, error: "network_error" }`. So the
 * action's try/catch never ran, and the page said "Something went wrong.
 * Nothing was booked." for a party that may exist. "network" is the outcome
 * that keeps the SAME idempotency key for the retry.
 */

const apiPublicSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiPublicSend, apiPublicGet: vi.fn() }));

const { groupCreateAction } = await import("./actions");

const input = {
  staffId: "stf_1",
  startsAt: "2026-03-14T18:00:00.000Z",
  attendees: [
    { firstName: "A", serviceId: "svc_1" },
    { firstName: "B", serviceId: "svc_1" },
  ],
  firstName: "A",
  idempotencyKey: "grp_key_123456789012",
} as unknown as Parameters<typeof groupCreateAction>[1];

beforeEach(() => apiPublicSend.mockReset());

describe("groupCreateAction", () => {
  it("🔴 a timeout (status 0) is a network outcome, so the retry keeps its key", async () => {
    apiPublicSend.mockResolvedValue({ ok: false, status: 0, data: null, error: "network_error" });
    expect(await groupCreateAction("cherncuts", input)).toEqual({ kind: "network" });
  });

  it("a real refusal is still an error", async () => {
    apiPublicSend.mockResolvedValue({ ok: false, status: 500, data: null, error: "internal" });
    expect((await groupCreateAction("cherncuts", input)).kind).toBe("error");
  });
});
