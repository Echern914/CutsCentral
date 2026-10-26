import { describe, expect, it } from "vitest";
import { ALIVE_PING, ALIVE_PROBE_JS, ALIVE_TIMEOUT_MS, STALE_AFTER_MS, shouldProbeOnReturn, shouldReloadOnReturn } from "./staleReturn";

describe("reloading a page left in the background", () => {
  const leftAt = 1_000_000;

  it("a quick app switch keeps the page (and anything typed in it)", () => {
    expect(shouldReloadOnReturn(leftAt, leftAt + 60_000)).toBe(false);
    expect(shouldReloadOnReturn(leftAt, leftAt + STALE_AFTER_MS - 1)).toBe(false);
  });

  it("a page left for half an hour or more is reloaded", () => {
    expect(shouldReloadOnReturn(leftAt, leftAt + STALE_AFTER_MS)).toBe(true);
    expect(shouldReloadOnReturn(leftAt, leftAt + 3 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("never left (first launch) means nothing to reload", () => {
    expect(shouldReloadOnReturn(null, leftAt)).toBe(false);
  });
});

describe("a short trip away: is the page still alive?", () => {
  const base = { leftAt: 1_000_000, loading: false, errored: false, reloading: false };

  it("asks the page on every return from the background", () => {
    expect(shouldProbeOnReturn(base)).toBe(true);
  });

  it.each([
    ["first launch (never left)", { leftAt: null }],
    ["still loading", { loading: true }],
    ["already on the error screen", { errored: true }],
    ["a stale reload is already starting", { reloading: true }],
  ])("doesn't ask when %s", (_why, over) => {
    expect(shouldProbeOnReturn({ ...base, ...over })).toBe(false);
  });

  it("the probe makes a live page answer with the ping, and a dead one gets a couple of seconds", () => {
    expect(ALIVE_PROBE_JS).toContain("window.ReactNativeWebView.postMessage(" + JSON.stringify(ALIVE_PING) + ")");
    expect(ALIVE_PROBE_JS.trim().endsWith("true;")).toBe(true);
    expect(ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(ALIVE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
