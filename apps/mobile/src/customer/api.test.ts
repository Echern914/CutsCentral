import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, errorCopy, publicPost } from "./api";

/**
 * Every failure a screen can meet collapses to a kind it knows how to say -
 * and a dead session signs the customer out instead of stranding them on a
 * screen that can only fail.
 */

function respond(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("the client", () => {
  it("sends the session as a Bearer header and returns the body", async () => {
    const fetchImpl = respond(200, { ok: 1 });
    const api = createApiClient({ origin: "https://api.test", token: () => "tok", onUnauthorized: vi.fn(), fetchImpl });
    await expect(api.get("/api/me/home")).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/me/home");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("🔴 a 401 signs the customer out", async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient({ origin: "o", token: () => "tok", onUnauthorized, fetchImpl: respond(401) });
    await expect(api.get("/x")).rejects.toMatchObject({ kind: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("no session at all never touches the network", async () => {
    const fetchImpl = respond(200);
    const onUnauthorized = vi.fn();
    const api = createApiClient({ origin: "o", token: () => null, onUnauthorized, fetchImpl });
    await expect(api.get("/x")).rejects.toMatchObject({ kind: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps statuses to kinds, keeping the API's code", async () => {
    const cases: [number, string][] = [
      [404, "not_found"],
      [429, "rate_limited"],
      [400, "invalid"],
      [409, "invalid"],
      [500, "server"],
      [503, "server"],
    ];
    for (const [status, kind] of cases) {
      const api = createApiClient({
        origin: "o",
        token: () => "t",
        onUnauthorized: vi.fn(),
        fetchImpl: respond(status, { error: "some_code" }),
      });
      await expect(api.get("/x")).rejects.toMatchObject({ kind, status, code: "some_code" });
    }
  });

  it("a network failure is 'offline', not a crash", async () => {
    const api = createApiClient({
      origin: "o",
      token: () => "t",
      onUnauthorized: vi.fn(),
      fetchImpl: vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    });
    await expect(api.get("/x")).rejects.toMatchObject({ kind: "offline" });
  });

  it("a request that never answers times out as 'offline'", async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const api = createApiClient({ origin: "o", token: () => "t", onUnauthorized: vi.fn(), fetchImpl: hang, timeoutMs: 20 });
    await expect(api.get("/x")).rejects.toMatchObject({ kind: "offline" });
  });

  it("sign-in calls carry no session", async () => {
    const fetchImpl = respond(200, { ok: true });
    await publicPost("https://api.test", "/api/customer-auth/start", { channel: "sms", phone: "x" }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("what the screens say", () => {
  it("offline reads as offline; everything unknown reads calmly", () => {
    expect(errorCopy(new ApiError("offline", 0)).title).toBe("You're offline");
    expect(errorCopy(new Error("boom")).title).toBe("Something went wrong");
  });
});
