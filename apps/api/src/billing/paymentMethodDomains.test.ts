import { describe, expect, it } from "vitest";
import { walletDomains } from "./paymentMethodDomains.js";

/**
 * Which hosts we ask Stripe to register for Apple Pay.
 *
 * The failure this guards is invisible in every other test: an unregistered
 * domain does not error, it just makes Apple Pay silently absent from the
 * Payment Element. So the SET of domains is the thing worth pinning.
 */
describe("walletDomains", () => {
  it("🔴 registers www alongside the apex - Apple treats them as different sites", () => {
    expect(walletDomains("https://getchairback.com")).toEqual([
      "getchairback.com",
      "www.getchairback.com",
    ]);
  });

  it("pairs the other way round when the deployment IS the www host", () => {
    expect(walletDomains("https://www.getchairback.com")).toEqual([
      "www.getchairback.com",
      "getchairback.com",
    ]);
  });

  it("does not invent a www for a deeper subdomain", () => {
    // "www.staging.getchairback.com" is not a host anyone serves.
    expect(walletDomains("https://staging.getchairback.com")).toEqual([
      "staging.getchairback.com",
    ]);
  });

  it("asks for nothing on hosts Apple can never serve, so dev and CI stay offline", () => {
    for (const url of [
      "http://localhost:3000",
      "http://localhost",
      "http://127.0.0.1:3100",
      "http://dev.local",
      "not a url",
      "",
    ]) {
      expect(walletDomains(url), url).toEqual([]);
    }
  });

  it("ignores the path, port and scheme - only the host is registrable", () => {
    expect(walletDomains("https://getchairback.com/book/cherncuts?x=1")).toEqual([
      "getchairback.com",
      "www.getchairback.com",
    ]);
  });

  it("lower-cases the host, because Stripe stores it verbatim", () => {
    expect(walletDomains("https://GetChairBack.com")).toEqual([
      "getchairback.com",
      "www.getchairback.com",
    ]);
  });
});
