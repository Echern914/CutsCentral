import { describe, expect, it } from "vitest";
import {
  LOGIN_NEXT_ALLOWLIST,
  SIGNUP_NEXT_ALLOWLIST,
  safeNextPath,
} from "./nextPath.js";

/**
 * The redirect allowlist.
 *
 * Two failures are being pinned here at once. The SECURITY one is the classic
 * open redirect, in every encoding a browser will happily undo for an attacker.
 * The PRODUCT one is subtler and is what shipped: signup ignored `next`
 * entirely, so an invited barber who created their account from the invitation
 * link landed in /onboarding - the shop-CREATION wizard - instead of back at
 * the invitation. They had to go find the email again.
 */

const FALLBACK = "/onboarding";

describe("accepts the destinations the flow actually needs", () => {
  it("keeps a team invitation, token and all, through signup", () => {
    const next = "/team/join?token=Ab3-_x9";
    expect(safeNextPath(next, SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(next);
  });

  it("keeps the gated surfaces the middleware bounces, on login", () => {
    for (const path of ["/dashboard", "/dashboard/clients", "/admin", "/onboarding"]) {
      expect(safeNextPath(path, LOGIN_NEXT_ALLOWLIST, "/dashboard")).toBe(path);
    }
  });

  it("returns the value verbatim - never a re-encoded near-miss", () => {
    const next = "/team/join?token=a%2Bb";
    expect(safeNextPath(next, SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(next);
  });
});

describe("refuses to send anyone off-origin", () => {
  it.each([
    ["absolute http", "https://evil.example/team/join"],
    ["absolute, no scheme", "//evil.example"],
    ["backslash protocol-relative", "/\evil.example"],
    ["encoded protocol-relative", "/%2f%2fevil.example"],
    ["double-encoded", "/%252f%252fevil.example"],
    ["scheme smuggled in a path", "/team/join/https://evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["tab-split protocol-relative", "/\t/evil.example"],
    ["newline injection", "/team/join\n/evil"],
  ])("rejects %s", (_label, candidate) => {
    expect(safeNextPath(candidate, LOGIN_NEXT_ALLOWLIST, FALLBACK)).toBe(FALLBACK);
  });
});

describe("refuses destinations outside the allowlist", () => {
  it("rejects an internal path nobody approved", () => {
    expect(safeNextPath("/settings/billing", SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("rejects traversal that resolves out of an approved prefix", () => {
    expect(
      safeNextPath("/team/join/../../admin", SIGNUP_NEXT_ALLOWLIST, FALLBACK),
    ).toBe(FALLBACK);
  });

  it("rejects a prefix match that is really a different path", () => {
    expect(safeNextPath("/team/joinsomewhere", SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("does not let signup reach the surfaces login can", () => {
    expect(safeNextPath("/dashboard", SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(FALLBACK);
  });
});

describe("junk input", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["not a string", 42],
    ["relative without a leading slash", "team/join"],
  ])("falls back for %s", (_label, candidate) => {
    expect(safeNextPath(candidate, SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for an absurdly long value", () => {
    expect(
      safeNextPath(`/team/join?token=${"a".repeat(600)}`, SIGNUP_NEXT_ALLOWLIST, FALLBACK),
    ).toBe(FALLBACK);
  });

  it("keeps an undecodable-but-relative value rather than erroring", () => {
    const next = "/team/join?token=100%";
    expect(safeNextPath(next, SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(next);
  });
});
