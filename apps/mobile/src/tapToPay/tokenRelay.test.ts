import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenRelay } from "./tokenRelay";

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenRelay", () => {
  it("asks the page and resolves with what it sends back", async () => {
    const asked: string[] = [];
    const relay = new TokenRelay((nonce) => asked.push(nonce));
    const p = relay.request();
    expect(asked).toHaveLength(1);
    relay.settle(asked[0]!, "pst_secret");
    await expect(p).resolves.toBe("pst_secret");
  });

  it("🔴 rejects when the page cannot fetch one, rather than hanging the SDK", async () => {
    // A tokenProvider that never settles hangs the SDK with no error and no
    // timeout - a barber holding the phone out while nothing happens.
    const asked: string[] = [];
    const relay = new TokenRelay((nonce) => asked.push(nonce));
    const p = relay.request();
    relay.settle(asked[0]!, null);
    await expect(p).rejects.toThrow(/could not fetch/);
  });

  it("🔴 rejects when the page never answers at all", async () => {
    vi.useFakeTimers();
    const relay = new TokenRelay(() => {}, 1000);
    const p = relay.request();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("rejects when the page cannot even be asked", async () => {
    const relay = new TokenRelay(() => {
      throw new Error("webview gone");
    });
    await expect(relay.request()).rejects.toThrow(/webview gone/);
  });

  it("keeps concurrent requests apart and ignores a late or unknown reply", async () => {
    const asked: string[] = [];
    const relay = new TokenRelay((nonce) => asked.push(nonce));
    const a = relay.request();
    const b = relay.request();
    expect(asked[0]).not.toBe(asked[1]);

    relay.settle(asked[1]!, "second");
    relay.settle(asked[0]!, "first");
    await expect(a).resolves.toBe("first");
    await expect(b).resolves.toBe("second");

    // Replays and strays must not throw or resolve anything.
    expect(() => relay.settle(asked[0]!, "again")).not.toThrow();
    expect(() => relay.settle("never-issued", "x")).not.toThrow();
  });

  it("fails everything outstanding when the screen goes away", async () => {
    const relay = new TokenRelay(() => {});
    const p = relay.request();
    relay.dispose();
    await expect(p).rejects.toThrow(/dismissed/);
  });
});
