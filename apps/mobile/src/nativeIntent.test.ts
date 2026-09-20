import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";

/**
 * Where a tapped link lands. A shop's /r/<token> link has no route of its own
 * in the app; left alone it would hit the router's "unmatched route" screen.
 * It must open that shop's page inside My ChairBack instead - and nothing
 * else the app is linked to may be disturbed.
 */
const go = (path: string) => redirectSystemPath({ path, initial: true });

describe("a shop's link opens that shop inside My ChairBack", () => {
  it.each([
    "https://getchairback.com/r/Abc_123-xyz",
    "chairback://r/Abc_123-xyz",
    "/r/Abc_123-xyz",
    "https://getchairback.com/r/Abc_123-xyz/rewards",
    "https://getchairback.com/r/Abc_123-xyz?utm=text",
  ])("%s", (path) => {
    expect(go(path)).toBe("/customer/link?token=Abc_123-xyz");
  });

  it("an encoded token is decoded once, then safely re-encoded", () => {
    expect(go("/r/a%2Bb")).toBe("/customer/link?token=a%2Bb");
  });
});

describe("a scanned QR code opens that shop inside the app", () => {
  // Every QR a shop prints encodes https://getchairback.com/book/<slug>. The
  // web host claims /book/* in its AASA, so these arrive here instead of Safari.
  it.each([
    "https://getchairback.com/book/cherncuts",
    "chairback://book/cherncuts",
    "/book/cherncuts",
  ])("%s keeps the shop", (path) => {
    expect(go(path)).toBe("/customer/link?path=%2Fbook%2Fcherncuts");
  });

  it("🔴 a targeted link keeps its prefill - the query string survives the hop", () => {
    // ?service=/?staff= is what a shop's "book this with me" text carries. If
    // the hop into the app dropped it, the customer would land on the generic
    // booking page and the link would have been a downgrade, not a shortcut.
    expect(go("https://getchairback.com/book/cherncuts?service=svc_1&staff=stf_2")).toBe(
      "/customer/link?path=%2Fbook%2Fcherncuts%3Fservice%3Dsvc_1%26staff%3Dstf_2",
    );
  });

  it("🔴 a manage link goes to the SIGNED-OUT screen, not /customer/manage", () => {
    // The token in the URL is the authentication. /customer/manage/[id] wants
    // an appointment id and a signed-in session, so sending this there would
    // ask a customer with no account to sign in to open their own booking.
    expect(go("https://getchairback.com/book/manage/mt_abc123")).toBe(
      "/customer/link?path=%2Fbook%2Fmanage%2Fmt_abc123",
    );
  });

  it("a bare /book with no shop is not a shop link", () => {
    expect(go("/book")).toBe("/book");
  });
});

describe("every other link passes through untouched", () => {
  it.each(["/team/join?code=abc", "/auth/mobile/callback?state=x", "/", "/customer"])("%s", (path) => {
    expect(go(path)).toBe(path);
  });

  it("a malformed link goes to the start, never a crash", () => {
    expect(go("/r/%E0%A4%A")).toBe("/");
  });
});
