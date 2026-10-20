import { describe, expect, it } from "vitest";
import { mintBookingHandoff, readBookingHandoff, withBookingHandoff, BOOKING_HANDOFF_TTL_SECONDS } from "./bookingHandoff.js";
import { customerSessionFromToken, mintCustomerSession } from "./customerSession.js";
import { sessionFromToken } from "./session.js";

/**
 * The booking handoff: a signed "this account, this shop" that rides on the
 * URLs the app opens, so a booking made there lands on the customer's own
 * record. Its whole power is that one sentence - so it must never be anything
 * else, nor anything else be it.
 */
const NOW = 1_800_000_000;
const p = { accountId: "acct_1", shopId: "shop_1", tokenVersion: 3 };

describe("booking handoff", () => {
  it("reads back the account and version, for the shop it was minted for", () => {
    expect(readBookingHandoff(mintBookingHandoff(p, NOW), "shop_1", NOW + 60)).toEqual({
      accountId: "acct_1",
      tokenVersion: 3,
    });
  });

  it("is nothing at another shop, after it expires, or once tampered with", () => {
    const h = mintBookingHandoff(p, NOW);
    expect(readBookingHandoff(h, "shop_2", NOW)).toBeNull();
    expect(readBookingHandoff(h, "shop_1", NOW + BOOKING_HANDOFF_TTL_SECONDS)).toBeNull();
    const [payload, sig] = h.split(".");
    const forged = Buffer.from(JSON.stringify({ purpose: "customer_booking_v1", a: "acct_2", s: "shop_1", v: 3, exp: NOW + 999 })).toString("base64url");
    expect(readBookingHandoff(`${forged}.${sig}`, "shop_1", NOW)).toBeNull();
    expect(readBookingHandoff(`${payload}.${sig}x`, "shop_1", NOW)).toBeNull();
    expect(readBookingHandoff("", "shop_1", NOW)).toBeNull();
    expect(readBookingHandoff("x".repeat(2000), "shop_1", NOW)).toBeNull();
  });

  it("🔴 is never a session - customer or business - and a session is never a handoff", () => {
    const h = mintBookingHandoff(p, Math.floor(Date.now() / 1000));
    expect(customerSessionFromToken(h)).toBeNull();
    expect(sessionFromToken(h)).toBeNull();
    expect(readBookingHandoff(mintCustomerSession("acct_1", 3), "shop_1")).toBeNull();
  });

  it("rides on a URL with or without a query already there", () => {
    expect(withBookingHandoff("https://x.test/r/tok", "a.b")).toBe("https://x.test/r/tok?cb_me=a.b");
    expect(withBookingHandoff("https://x.test/book/s?service=1", "a.b")).toBe("https://x.test/book/s?service=1&cb_me=a.b");
  });
});
