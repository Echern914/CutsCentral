import { describe, expect, it } from "vitest";
import {
  LOGIN_NEXT_ALLOWLIST,
  MOBILE_HANDOFF_NEXT_ALLOWLIST,
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
    // The ceiling moved from 512 to 2048 when the MCP consent resume needed to
    // carry a whole OAuth authorization request. The RULE is unchanged - a
    // value past the ceiling is discarded - so this exercises the new one.
    expect(
      safeNextPath(`/team/join?token=${"a".repeat(2100)}`, SIGNUP_NEXT_ALLOWLIST, FALLBACK),
    ).toBe(FALLBACK);
  });

  it("keeps an undecodable-but-relative value rather than erroring", () => {
    const next = "/team/join?token=100%";
    expect(safeNextPath(next, SIGNUP_NEXT_ALLOWLIST, FALLBACK)).toBe(next);
  });
});

/**
 * The native app's hand-off list. It is a CAPABILITY: whatever is on it can end
 * a browser flow by minting a session back into the app, so these assert the
 * boundary in both directions.
 */
describe("MOBILE_HANDOFF_NEXT_ALLOWLIST", () => {
  const FB = "";

  it("admits the invitation flow, token and all", () => {
    const next = "/team/join?token=abc123";
    expect(safeNextPath(next, MOBILE_HANDOFF_NEXT_ALLOWLIST, FB)).toBe(next);
  });

  it("admits shop creation", () => {
    expect(safeNextPath("/onboarding", MOBILE_HANDOFF_NEXT_ALLOWLIST, FB)).toBe(
      "/onboarding",
    );
  });

  it("REFUSES /dashboard", () => {
    // A code is minted at the END of a flow, once the thing the app needs
    // exists. Allowing the dashboard would let a half-finished signup hand back
    // a session for an account with no shop.
    expect(safeNextPath("/dashboard", MOBILE_HANDOFF_NEXT_ALLOWLIST, FB)).toBe(FB);
  });

  it("REFUSES /admin", () => {
    expect(safeNextPath("/admin", MOBILE_HANDOFF_NEXT_ALLOWLIST, FB)).toBe(FB);
  });

  it("refuses an absolute URL wearing an allowed path", () => {
    expect(
      safeNextPath("https://evil.example/onboarding", MOBILE_HANDOFF_NEXT_ALLOWLIST, FB),
    ).toBe(FB);
  });

  it("refuses a lookalike prefix", () => {
    expect(
      safeNextPath("/onboarding-evil", MOBILE_HANDOFF_NEXT_ALLOWLIST, FB),
    ).toBe(FB);
  });

  it("stays NARROWER than the login list, which admits the dashboard", () => {
    // If these ever converge, the hand-off has quietly gained reach it was
    // never meant to have.
    expect([...MOBILE_HANDOFF_NEXT_ALLOWLIST]).not.toContain("/dashboard");
  });
});

/**
 * 🔴 THE MCP CONSENT RESUME, AND THE HOLE IT MUST NOT OPEN.
 *
 * An assistant sends a barber to /mcp/authorize with the whole authorization
 * request in the query. If they are signed out, the middleware bounces them to
 * /login carrying that as `next` — and every parameter has to survive, because
 * a consent screen with no client, no PKCE challenge and no state cannot
 * complete. That failure surfaced as Claude reporting "authorization failed".
 *
 * Making it work required narrowing the `://` check to the PATH portion, since
 * a legitimate `redirect_uri` query value contains "https://". These tests pin
 * both halves: the flow works, AND every open-redirect form is still refused.
 */
describe("resuming an MCP authorization after login", () => {
  const OAUTH_NEXT =
    "/mcp/authorize?client_id=cb_mcp_abc123&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
    "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256" +
    "&resource=https%3A%2F%2Fapi.getchairback.com%2Fmcp&scope=chairback%3Ahelp%3Aread+chairback%3Areadiness%3Aread&state=xyz";

  it("survives intact, query and all", () => {
    // Returning the fallback here is the bug that broke the live connect flow.
    expect(safeNextPath(OAUTH_NEXT, LOGIN_NEXT_ALLOWLIST, "/dashboard")).toBe(OAUTH_NEXT);
  });

  it("keeps the parameters a consent screen cannot work without", () => {
    const out = safeNextPath(OAUTH_NEXT, LOGIN_NEXT_ALLOWLIST, "/dashboard");
    for (const key of ["client_id=", "code_challenge=", "state=", "redirect_uri="]) {
      expect(out).toContain(key);
    }
  });

  it("accepts the bare consent path too", () => {
    expect(safeNextPath("/mcp/authorize", LOGIN_NEXT_ALLOWLIST, "/dashboard")).toBe(
      "/mcp/authorize",
    );
  });

  it("🔴 still refuses every open-redirect form, decoded or not", () => {
    // The narrowing must not have bought the flow at the cost of the control
    // this module exists for.
    const hostile = [
      "https://evil.example",
      "http://evil.example",
      "//evil.example",
      "/\evil.example",
      "/%2f%2fevil.example",
      "/%2F%2Fevil.example",
      "/%252f%252fevil.example",
      "\\evil.example",
      "/mcp/../admin",
      "/mcp/authorize/../../admin",
      " //evil.example",
      "/\t/evil.example",
    ];
    for (const value of hostile) {
      expect(safeNextPath(value, LOGIN_NEXT_ALLOWLIST, "/dashboard"), value).toBe("/dashboard");
    }
  });

  it("🔴 a scheme in the PATH is still refused; only the query may hold one", () => {
    // The distinction the narrowing draws, stated as a test.
    expect(safeNextPath("/mcp/https://evil.example", LOGIN_NEXT_ALLOWLIST, "/dashboard")).toBe(
      "/dashboard",
    );
    expect(
      safeNextPath("/mcp/authorize?u=https%3A%2F%2Fclaude.ai", LOGIN_NEXT_ALLOWLIST, "/dashboard"),
    ).toBe("/mcp/authorize?u=https%3A%2F%2Fclaude.ai");
  });

  it("does not widen any other allowlist", () => {
    // /mcp is a LOGIN resume only. A signup or a native hand-off has no
    // business landing on a consent screen.
    expect(safeNextPath(OAUTH_NEXT, SIGNUP_NEXT_ALLOWLIST, "/onboarding")).toBe("/onboarding");
    expect(safeNextPath(OAUTH_NEXT, MOBILE_HANDOFF_NEXT_ALLOWLIST, "/onboarding")).toBe(
      "/onboarding",
    );
  });

  it("a realistic request fits inside the length ceiling", () => {
    // 512 was too small once state and an encoded redirect_uri were included,
    // and the symptom was an unexplained fallback rather than an error.
    expect(OAUTH_NEXT.length).toBeGreaterThan(200);
    expect(safeNextPath(OAUTH_NEXT, LOGIN_NEXT_ALLOWLIST, "/dashboard")).not.toBe("/dashboard");
  });

  it("an absurdly long value is still refused", () => {
    const huge = `/mcp/authorize?state=${"a".repeat(4000)}`;
    expect(safeNextPath(huge, LOGIN_NEXT_ALLOWLIST, "/dashboard")).toBe("/dashboard");
  });
});
