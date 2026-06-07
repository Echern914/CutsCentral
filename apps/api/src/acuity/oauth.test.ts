import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  createOAuthState,
  verifyOAuthState,
} from "./oauth.js";

const NOW = 1_700_000_000;

describe("OAuth CSRF state", () => {
  it("round-trips a valid state bound to a shop", () => {
    const token = createOAuthState("shop_123", NOW);
    const state = verifyOAuthState(token, NOW + 5);
    expect(state?.shopId).toBe("shop_123");
  });

  it("rejects a tampered state", () => {
    const token = createOAuthState("shop_123", NOW);
    const tampered = token.slice(0, -3) + "AAA";
    expect(verifyOAuthState(tampered, NOW + 5)).toBeNull();
  });

  it("rejects an expired state", () => {
    const token = createOAuthState("shop_123", NOW);
    // TTL is 10 min; jump past it.
    expect(verifyOAuthState(token, NOW + 11 * 60)).toBeNull();
  });

  it("rejects missing/garbage states", () => {
    expect(verifyOAuthState(undefined, NOW)).toBeNull();
    expect(verifyOAuthState("", NOW)).toBeNull();
    expect(verifyOAuthState("no-dot", NOW)).toBeNull();
  });

  it("two states for the same shop differ (random nonce)", () => {
    expect(createOAuthState("shop_123", NOW)).not.toBe(
      createOAuthState("shop_123", NOW),
    );
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the required Acuity OAuth params", () => {
    const url = new URL(buildAuthorizeUrl("the-state"));
    expect(url.origin + url.pathname).toBe(
      "https://acuityscheduling.com/oauth2/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("api-v1");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBeTruthy();
  });
});
