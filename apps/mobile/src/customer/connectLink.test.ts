import { describe, expect, it } from "vitest";
import { isShopLinkNotPersonal } from "./connectLink";

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
