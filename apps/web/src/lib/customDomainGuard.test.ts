import { describe, expect, it } from "vitest";
import { DOMAIN_PARAM, expectedDomain, normalizeDomain, servesDomain } from "./customDomainGuard";

/**
 * The same-shop rule for a visit that came through a custom domain. Pure, so
 * every edge is pinned here and the pages only have to call it.
 */

describe("normalizeDomain", () => {
  it("case, a port, the root dot and www are all the same domain", () => {
    for (const raw of ["DrickCuttinUp.com", "drickcuttinup.com:443", "drickcuttinup.com.", "www.drickcuttinup.com", " WWW.DRICKCUTTINUP.COM. "]) {
      expect(normalizeDomain(raw)).toBe("drickcuttinup.com");
    }
  });

  it("takes an international name in the punycode form browsers send", () => {
    expect(normalizeDomain("xn--brbier-bua.com")).toBe("xn--brbier-bua.com");
  });

  it("refuses anything that is not a hostname", () => {
    for (const raw of ["", "localhost", "drick cuttinup.com", "drickcuttinup", "a..com", "-drick.com", "drick.c0m", `${"a".repeat(250)}.com`]) {
      expect(normalizeDomain(raw)).toBeNull();
    }
  });
});

describe("expectedDomain", () => {
  it("an ordinary visit expects nothing - the page renders exactly as before", () => {
    expect(expectedDomain(undefined)).toBeNull();
    expect(expectedDomain({})).toBeNull();
    expect(expectedDomain({ utm_source: "ig" })).toBeNull();
  });

  it("a custom-domain visit expects that domain, normalized", () => {
    expect(expectedDomain({ [DOMAIN_PARAM]: "DrickCuttinUp.com" })).toBe("drickcuttinup.com");
  });

  it("🔴 a marker that is present but unusable is not ignored", () => {
    expect(expectedDomain({ [DOMAIN_PARAM]: "" })).toBe("invalid");
    expect(expectedDomain({ [DOMAIN_PARAM]: "not a domain" })).toBe("invalid");
    expect(expectedDomain({ [DOMAIN_PARAM]: ["a.com", "b.com"] })).toBe("invalid");
  });
});

describe("servesDomain", () => {
  it("renders the shop that owns the verified domain", () => {
    expect(servesDomain({ customDomain: "drickcuttinup.com" }, "drickcuttinup.com")).toBe(true);
    // Stored forms are compared normalized, never trusted verbatim.
    expect(servesDomain({ customDomain: "DrickCuttinUp.com" }, "drickcuttinup.com")).toBe(true);
  });

  it("🔴 fails closed for any other shop - including one with no domain at all", () => {
    expect(servesDomain({ customDomain: "otherbarber.com" }, "drickcuttinup.com")).toBe(false);
    // null = this shop has no verified domain. It is the reclaimed-slug case:
    // the new holder of the name, which owns no domain.
    expect(servesDomain({ customDomain: null }, "drickcuttinup.com")).toBe(false);
  });

  it("🔴 fails closed on a tampered marker once the API reports domains", () => {
    expect(servesDomain({ customDomain: "drickcuttinup.com" }, "invalid")).toBe(false);
    expect(servesDomain({ customDomain: null }, "invalid")).toBe(false);
  });

  it("no data is never a pass", () => {
    expect(servesDomain(null, null)).toBe(false);
    expect(servesDomain(null, "drickcuttinup.com")).toBe(false);
  });

  it("an ordinary visit renders any shop, exactly as before", () => {
    expect(servesDomain({ customDomain: null }, null)).toBe(true);
    expect(servesDomain({ customDomain: "otherbarber.com" }, null)).toBe(true);
  });

  it("an API that predates the field renders as it always has (deploy order)", () => {
    // Absent, not null: the web app deployed before the API. Refusing here
    // would 404 every custom-domain visitor until the API caught up.
    expect(servesDomain({}, "drickcuttinup.com")).toBe(true);
    expect(servesDomain({ customDomain: undefined }, "drickcuttinup.com")).toBe(true);
  });
});
