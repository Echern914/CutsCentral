import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, shouldReloadOnReturn } from "./staleReturn";

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
