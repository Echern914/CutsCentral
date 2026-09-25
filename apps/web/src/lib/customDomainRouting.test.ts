import { describe, expect, it } from "vitest";
import {
  customDomainKey,
  customDomainPath,
  customDomainTarget,
  normalizeHost,
} from "./customDomainRouting";

/**
 * How a request on a shop's own domain is read: the host it names and the
 * page it asks for. The shop itself is never decided here - see
 * lib/customDomain.ts - which is why nothing below ever looks at a slug.
 */

describe("normalizeHost", () => {
  it("case, a port and the root dot do not make a different name", () => {
    expect(normalizeHost("DrickCuttinUp.COM")).toBe("drickcuttinup.com");
    expect(normalizeHost("drickcuttinup.com:443")).toBe("drickcuttinup.com");
    expect(normalizeHost("drickcuttinup.com.")).toBe("drickcuttinup.com");
    expect(normalizeHost(" WWW.DrickCuttinUp.com.:8080 ")).toBe("www.drickcuttinup.com");
  });

  it("takes an international name in the punycode form browsers send", () => {
    expect(normalizeHost("xn--caf-dma.com")).toBe("xn--caf-dma.com");
  });

  it("refuses anything that is not a hostname, so it never reaches a lookup or a URL", () => {
    for (const bad of [
      "",
      "localhost",
      "127.0.0.1",
      "drick cuttinup.com",
      "-bad.com",
      "bad-.com",
      "a..com",
      "café.com", // unencoded - a browser never sends this
      `${"x".repeat(250)}.com`,
    ]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });
});

describe("customDomainKey", () => {
  it("resolves www and the apex as one domain", () => {
    expect(customDomainKey("www.drickcuttinup.com")).toBe("drickcuttinup.com");
    expect(customDomainKey("drickcuttinup.com")).toBe("drickcuttinup.com");
    // Only a leading www. is ours to strip.
    expect(customDomainKey("book.drickcuttinup.com")).toBe("book.drickcuttinup.com");
  });
});

describe("customDomainTarget", () => {
  const cases: [string, ReturnType<typeof customDomainTarget>][] = [
    // What the bare domain in a bio link is for.
    ["/", "shop"],
    ["/s/drickcuttinup", "shop"],
    // Booking, under every spelling the pages and old links use.
    ["/book", "book"],
    ["/book/drickcuttinup", "book"],
    ["/BOOK/DrickCuttinUp", "book"],
    ["/book/drickcuttinup/group", "group"],
    // Token routes identify ONE booking, not a shop: they stay on the platform.
    ["/book/manage/tok_123", "platform"],
    ["/book/manage/tok_123/wallet-pass", "platform"],
    ["/book/group/tok_456", "platform"],
    // Nothing else is a shop-domain page.
    ["/my-rewards", "platform"],
    ["/r/magic", "platform"],
    ["/login", "platform"],
    ["/dashboard", "platform"],
    ["/privacy", "platform"],
    ["/book/drickcuttinup/somewhere", "platform"],
    ["/s/drickcuttinup/extra", "platform"],
  ];
  it.each(cases)("%s -> %s", (path, target) => {
    expect(customDomainTarget(path)).toBe(target);
  });

  it("🔴 a slug in the path changes nothing: any shop's /book is still THIS domain's booking", () => {
    // The page the target maps to takes the host alone, so there is no
    // parameter a crafted /book/<other-shop> could reach.
    expect(customDomainTarget("/book/some-other-shop")).toBe("book");
    expect(customDomainPath("drickcuttinup.com", "book")).toBe("/custom-domain/drickcuttinup.com/book");
  });
});

describe("customDomainPath", () => {
  it("builds the internal route from the host alone", () => {
    expect(customDomainPath("drickcuttinup.com", "shop")).toBe("/custom-domain/drickcuttinup.com");
    expect(customDomainPath("drickcuttinup.com", "group")).toBe(
      "/custom-domain/drickcuttinup.com/book/group",
    );
  });
});
