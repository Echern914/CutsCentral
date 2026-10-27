import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
vi.mock("./api", () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

const { getPlatformNotices } = await import("./platformNotices");

/**
 * The dashboard layout asks for status notices on EVERY page load, for every
 * seat. Whatever goes wrong, the answer is "no notices" - never a thrown error
 * that would take the whole dashboard down with it.
 */
beforeEach(() => {
  apiGet.mockReset();
});

describe("getPlatformNotices", () => {
  it("returns what the API sent", async () => {
    apiGet.mockResolvedValue({ ok: true, status: 200, data: { notices: [{ id: "n1" }] } });
    expect(await getPlatformNotices()).toEqual([{ id: "n1" }]);
    expect(apiGet).toHaveBeenCalledWith("/api/platform-notices");
  });

  it.each([
    ["a network failure", { ok: false, status: 0, data: null, error: "network_error" }],
    ["an older API without the route", { ok: false, status: 404, data: null }],
    ["a malformed answer", { ok: true, status: 200, data: { notices: "nope" } }],
    ["an empty body", { ok: true, status: 200, data: null }],
  ])("🔴 %s is no notices, not an error", async (_label, result) => {
    apiGet.mockResolvedValue(result);
    expect(await getPlatformNotices()).toEqual([]);
  });

  it("🔴 even a thrown error is no notices", async () => {
    apiGet.mockImplementation(async () => {
      throw new Error("boom");
    });
    expect(await getPlatformNotices()).toEqual([]);
  });
});
