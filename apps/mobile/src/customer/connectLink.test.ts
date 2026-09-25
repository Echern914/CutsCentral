import { describe, expect, it } from "vitest";
import { isShopLinkNotPersonal, linkTarget } from "./connectLink";

describe("isShopLinkNotPersonal", () => {
  it("flags the shop's booking link a customer actually pasted (2026-09-24)", () => {
    expect(isShopLinkNotPersonal("getchairback.com/book/drickcuttinup")).toBe(true);
  });

  it("flags the shop page and the bare domain, with or without https", () => {
    expect(isShopLinkNotPersonal("https://getchairback.com/s/drickcuttinup")).toBe(true);
    expect(isShopLinkNotPersonal("https://www.getchairback.com/")).toBe(true);
    expect(isShopLinkNotPersonal("GetChairBack.com/drickcuttinup")).toBe(true);
  });

  it("does NOT flag a personal /r/ link, however it was pasted", () => {
    expect(isShopLinkNotPersonal("https://getchairback.com/r/AbCdEfGhIjKlMnOpQrSt")).toBe(false);
    expect(isShopLinkNotPersonal("  getchairback.com/r/abc_def-1234567890XY  ")).toBe(false);
  });

  it("leaves a bare token and non-ChairBack text for the server to judge", () => {
    expect(isShopLinkNotPersonal("AbCdEfGhIjKlMnOpQrSt")).toBe(false);
    expect(isShopLinkNotPersonal("hello")).toBe(false);
  });

  it("a /r/ path too short to be a token is still not a personal link", () => {
    expect(isShopLinkNotPersonal("getchairback.com/r/short")).toBe(true);
  });
});

describe("linkTarget", () => {
  it("a personal /r/ link or a bare token opens as the customer's own record", () => {
    expect(linkTarget("https://getchairback.com/r/AbCdEfGhIjKlMnOpQrSt?x=1")).toEqual({ token: "AbCdEfGhIjKlMnOpQrSt" });
    expect(linkTarget("  AbCdEfGhIjKlMnOpQrSt ")).toEqual({ token: "AbCdEfGhIjKlMnOpQrSt" });
  });

  it("a shop's page or booking link - a bio or a QR code - opens that page, path only", () => {
    expect(linkTarget("getchairback.com/s/united-barbershop")).toEqual({ path: "/s/united-barbershop" });
    expect(linkTarget("https://www.GetChairBack.com/book/DrickCuttinUp/?utm=ig")).toEqual({ path: "/book/drickcuttinup" });
  });

  it("anything else is not a ChairBack shop link - including someone else's host", () => {
    expect(linkTarget("https://evil.example/s/united-barbershop")).toBeNull();
    expect(linkTarget("getchairback.com.evil.example/s/x")).toBeNull();
    expect(linkTarget("hello")).toBeNull();
  });

  it("a stray % is refused, not a crash", () => {
    expect(linkTarget("getchairback.com/r/%E0%A4%A")).toBeNull();
  });
});
