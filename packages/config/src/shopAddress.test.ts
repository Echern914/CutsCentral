import { describe, expect, it } from "vitest";
import {
  formatShopAddress,
  hasShopAddress,
  mapsUrlFor,
  shopAddressLines,
} from "./shopAddress.js";

/**
 * The address is a fact customers ACT on - they drive to it. So the rules that
 * decide whether we have one, and how it reads, live in one place and are
 * pinned here.
 */

const FULL = {
  addressStreet: "123 Main St",
  addressCity: "Brooklyn",
  addressRegion: "NY",
  addressPostal: "11201",
};

describe("hasShopAddress", () => {
  it("🔴 needs street AND city - half an address is not navigable", () => {
    expect(hasShopAddress(FULL)).toBe(true);
    expect(hasShopAddress({ addressStreet: "123 Main St" })).toBe(false);
    expect(hasShopAddress({ addressCity: "Brooklyn" })).toBe(false);
    expect(hasShopAddress({})).toBe(false);
  });

  it("treats whitespace and empty strings as absent", () => {
    // A cleared field arrives as "" from the form, and as "  " from a paste.
    expect(hasShopAddress({ addressStreet: "  ", addressCity: "Brooklyn" })).toBe(false);
    expect(hasShopAddress({ addressStreet: "123 Main St", addressCity: "" })).toBe(false);
    expect(hasShopAddress({ addressStreet: null, addressCity: null })).toBe(false);
  });

  it("does not require region or postal", () => {
    expect(hasShopAddress({ addressStreet: "123 Main St", addressCity: "Brooklyn" })).toBe(true);
  });
});

describe("formatting", () => {
  it("reads the way a person writes an address", () => {
    expect(formatShopAddress(FULL)).toBe("123 Main St, Brooklyn, NY 11201");
    expect(shopAddressLines(FULL)).toEqual(["123 Main St", "Brooklyn, NY 11201"]);
  });

  it("drops the parts the shop left out, without leaving punctuation behind", () => {
    expect(formatShopAddress({ addressStreet: "1 Elm", addressCity: "Austin" })).toBe(
      "1 Elm, Austin",
    );
    expect(
      formatShopAddress({ addressStreet: "1 Elm", addressCity: "Austin", addressRegion: "TX" }),
    ).toBe("1 Elm, Austin, TX");
    expect(
      formatShopAddress({ addressStreet: "1 Elm", addressCity: "Austin", addressPostal: "78701" }),
    ).toBe("1 Elm, Austin, 78701");
  });

  it("trims what the barber typed", () => {
    expect(
      formatShopAddress({ addressStreet: "  1 Elm  ", addressCity: " Austin " }),
    ).toBe("1 Elm, Austin");
  });

  it("🔴 returns null rather than a partial address anything could render", () => {
    expect(formatShopAddress({ addressCity: "Brooklyn", addressRegion: "NY" })).toBeNull();
    expect(shopAddressLines({ addressCity: "Brooklyn" })).toEqual([]);
    // Spreadable with no conditional: an empty list renders no "Where" block.
    expect([...shopAddressLines({})]).toHaveLength(0);
  });
});

describe("mapsUrlFor", () => {
  it("builds a link that opens a map on every platform we send to", () => {
    expect(mapsUrlFor(FULL)).toBe(
      "https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Brooklyn%2C%20NY%2011201",
    );
  });

  it("escapes an address that would otherwise break the URL", () => {
    const url = mapsUrlFor({ addressStreet: "12 A&B St #3", addressCity: "Queens" });
    expect(url).toContain("12%20A%26B%20St%20%233");
    expect(url).not.toContain("&query=12 A&B");
  });

  it("is null when there is nowhere to send them", () => {
    expect(mapsUrlFor({})).toBeNull();
    expect(mapsUrlFor({ addressStreet: "123 Main St" })).toBeNull();
  });
});
