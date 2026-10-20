import { describe, expect, it } from "vitest";
import { isStaleDeploymentError, loadAction } from "./loadAction";

describe("loadAction", () => {
  it("passes an answer through untouched - judging it is the caller's job", async () => {
    expect(await loadAction(async () => ({ ok: false }))).toEqual({ ok: true, value: { ok: false } });
    expect(await loadAction(async () => null)).toEqual({ ok: true, value: null });
    expect(await loadAction(async () => ({ ok: true, rows: [1] }))).toEqual({
      ok: true,
      value: { ok: true, rows: [1] },
    });
  });

  it("🔴 undefined is a stale deployment: what Next 14.2 resolves for a server action the new build lacks", async () => {
    expect(await loadAction(async () => undefined)).toEqual({ ok: false, failure: "stale" });
  });

  it("a throw is a failure, not a crash", async () => {
    expect(await loadAction(() => Promise.reject(new TypeError("Load failed")))).toEqual({
      ok: false,
      failure: "failed",
    });
  });

  it("a throw in Next's own missing-action wording is a stale deployment", async () => {
    const err = new Error(
      'Failed to find Server Action "abc123". This request might be from an older or newer deployment.',
    );
    expect(isStaleDeploymentError(err)).toBe(true);
    expect(await loadAction(() => Promise.reject(err))).toEqual({ ok: false, failure: "stale" });
    expect(isStaleDeploymentError(new Error("fetch failed"))).toBe(false);
    expect(isStaleDeploymentError("Failed to find Server Action")).toBe(false);
  });
});
