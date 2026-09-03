import { describe, expect, it } from "vitest";
import {
  canReplaceConnectedAccount,
  createConnectState,
  verifyConnectState,
  standardConnectEnabled,
} from "./connectOauth.js";

/**
 * The CSRF state on the Standard Connect round-trip.
 *
 * 🔴 WHAT THIS PROTECTS. /callback has no session on it — it is Stripe redirecting
 * a browser back — so the signed state is the ONLY thing deciding which shop an
 * `acct_…` gets attached to. If a forged state were accepted, an attacker could
 * have their own Stripe account bound to somebody else's shop, or somebody
 * else's account bound to theirs. Either way a real barber's card payments
 * start landing in the wrong bank account, silently, and nothing about the
 * dashboard would look wrong.
 *
 * So these are falsifiers, not happy-path coverage: each one is a specific
 * forgery that must be REFUSED.
 */
describe("Connect OAuth state", () => {
  const NOW = 1_700_000_000;
  const SHOP = "shop_abc123";

  it("round-trips the shop it was minted for", () => {
    const state = createConnectState(SHOP, NOW);
    expect(verifyConnectState(state, NOW)).toMatchObject({ shopId: SHOP });
  });

  it("🔴 refuses a state whose payload was edited to another shop", () => {
    // The exact attack: take a legitimately-signed state, swap the shop id,
    // re-encode. The signature no longer covers the payload.
    const state = createConnectState(SHOP, NOW);
    const [b64, sig] = state.split(".");
    const payload = JSON.parse(Buffer.from(b64!, "base64url").toString("utf8"));
    payload.shopId = "shop_victim";
    const forged =
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") + "." + sig;
    expect(verifyConnectState(forged, NOW)).toBeNull();
  });

  it("🔴 refuses an unsigned state (payload only, no HMAC)", () => {
    const b64 = Buffer.from(
      JSON.stringify({ shopId: SHOP, nonce: "x", exp: NOW + 600 }),
      "utf8",
    ).toString("base64url");
    expect(verifyConnectState(b64, NOW)).toBeNull();
    expect(verifyConnectState(`${b64}.`, NOW)).toBeNull();
  });

  it("🔴 refuses a signature of the wrong LENGTH without throwing", () => {
    // timingSafeEqual THROWS on a length mismatch, and a short signature is the
    // cheapest possible probe. The length check must come first, or every such
    // probe becomes a 500 instead of a clean refusal.
    const state = createConnectState(SHOP, NOW);
    const [b64] = state.split(".");
    expect(() => verifyConnectState(`${b64}.deadbeef`, NOW)).not.toThrow();
    expect(verifyConnectState(`${b64}.deadbeef`, NOW)).toBeNull();
  });

  it("expires: valid one second before, refused one second after", () => {
    const state = createConnectState(SHOP, NOW);
    const exp = verifyConnectState(state, NOW)!.exp;
    expect(verifyConnectState(state, exp - 1)).not.toBeNull();
    expect(verifyConnectState(state, exp)).toBeNull(); // exp is not "still valid"
    expect(verifyConnectState(state, exp + 1)).toBeNull();
  });

  it("refuses empty, malformed and non-token input rather than throwing", () => {
    for (const bad of [undefined, null, "", ".", "..", "not-a-state", "a.b.c"]) {
      expect(() => verifyConnectState(bad as string | undefined, NOW)).not.toThrow();
      expect(verifyConnectState(bad as string | undefined, NOW)).toBeNull();
    }
  });

  it("mints a distinct nonce per call, so two flows are never interchangeable", () => {
    const a = verifyConnectState(createConnectState(SHOP, NOW), NOW)!;
    const b = verifyConnectState(createConnectState(SHOP, NOW), NOW)!;
    expect(a.nonce).not.toBe(b.nonce);
  });
});

/**
 * The Standard door needs its OWN credential (the ca_… client id), separate from
 * the secret key. This is what lets Express keep working while Standard is dark,
 * which is exactly the state of every environment until the client id is set.
 */
describe("standardConnectEnabled", () => {
  it("is false without STRIPE_CONNECT_CLIENT_ID", () => {
    // The test env sets no Stripe credentials at all, so this is the real
    // default: the second button must not be offered.
    if (!process.env.STRIPE_CONNECT_CLIENT_ID || !process.env.STRIPE_SECRET_KEY) {
      expect(standardConnectEnabled()).toBe(false);
    }
  });
});

/**
 * Whether linking a barber's OWN account may replace the one the shop holds.
 * The unfinished-Express case is the one every stuck shop was in on
 * 2026-09-02; the other rows are the money-holding states that must never be
 * overwritten without a deliberate Disconnect.
 */
describe("canReplaceConnectedAccount", () => {
  it("an unfinished Express account (never able to charge) may be replaced", () => {
    expect(canReplaceConnectedAccount({ type: "express", chargesEnabled: false })).toBe(true);
    // Rows from before the type column existed are Express too.
    expect(canReplaceConnectedAccount({ type: null, chargesEnabled: false })).toBe(true);
  });

  it("a WORKING Express account is never silently replaced - it may hold money", () => {
    expect(canReplaceConnectedAccount({ type: "express", chargesEnabled: true })).toBe(false);
  });

  it("a Standard account is never replaced by another, finished or not", () => {
    expect(canReplaceConnectedAccount({ type: "standard", chargesEnabled: false })).toBe(false);
    expect(canReplaceConnectedAccount({ type: "standard", chargesEnabled: true })).toBe(false);
  });
});
