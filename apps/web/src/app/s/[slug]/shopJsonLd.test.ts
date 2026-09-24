import { describe, expect, it } from "vitest";
import { shopJsonLd, type ShopJsonLdInput } from "./shopJsonLd";

/**
 * The LocalBusiness JSON-LD - what Google reads off the shop's page.
 *
 *  - THE ADDRESS is built from the public page payload, which already carries
 *    the stranger's view of it: a shop that keeps its street private must come
 *    out of here as a TOWN, and still as a local business.
 *  - THE RATING: once star-only ratings stopped being shown as cards,
 *    "ratings" and "reviews" became different numbers. The average covers
 *    every approved rating, while only the ones with words are reviews on the
 *    page. Markup claiming 37 reviews over a page that shows 12 is exactly the
 *    mismatch that gets it ignored, so each number goes in the field that
 *    means it.
 */

const BASE: ShopJsonLdInput = {
  name: "Home Studio",
  slug: "home-studio",
  industry: "barber",
  bio: null,
  logoUrl: null,
  receptionistNumber: null,
  addressStreet: "123 Main St",
  addressCity: "Wilmington",
  addressRegion: "DE",
  addressPostal: "19801",
  reviewSummary: { count: 0, avgRating: null },
};

/** What GET /api/page/:slug sends for a shop that keeps its address private. */
const PRIVATE: ShopJsonLdInput = { ...BASE, addressStreet: null, addressPostal: null };

const rating = (summary: ShopJsonLdInput["reviewSummary"]) =>
  shopJsonLd({ ...BASE, reviewSummary: summary }).aggregateRating as
    | Record<string, unknown>
    | undefined;

describe("shopJsonLd address", () => {
  it("publishes the full postal address of a shop that has not made it private", () => {
    expect(shopJsonLd(BASE).address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "123 Main St",
      addressLocality: "Wilmington",
      addressRegion: "DE",
      postalCode: "19801",
      addressCountry: "US",
    });
  });

  it("🔴 a private shop is still a local business - in its town, with no door", () => {
    const ld = shopJsonLd(PRIVATE);
    expect(ld.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Wilmington",
      addressRegion: "DE",
      addressCountry: "US",
    });
    const markup = JSON.stringify(ld);
    expect(markup).not.toContain("streetAddress");
    expect(markup).not.toContain("postalCode");
  });

  it("a ZIP travels only with a street", () => {
    const ld = shopJsonLd({ ...BASE, addressStreet: null });
    expect(ld.address).not.toHaveProperty("postalCode");
    expect(ld.address).toHaveProperty("addressLocality", "Wilmington");
  });

  it("publishes no address without a city - a street or a state alone is nowhere", () => {
    expect(shopJsonLd({ ...BASE, addressCity: null })).not.toHaveProperty("address");
    expect(shopJsonLd({ ...PRIVATE, addressCity: "  " })).not.toHaveProperty("address");
  });

  it("keeps the business identity whatever happens to the address", () => {
    const ld = shopJsonLd(PRIVATE);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld.name).toBe("Home Studio");
    expect(ld.url).toBe("https://getchairback.com/s/home-studio");
    expect(typeof ld["@type"]).toBe("string");
  });
});

describe("aggregateRating", () => {
  it("🔴 ratingCount is every approved rating; reviewCount only the ones with words", () => {
    expect(rating({ count: 37, avgRating: 4.8649, writtenCount: 12 })).toMatchObject({
      "@type": "AggregateRating",
      ratingValue: 4.86,
      ratingCount: 37,
      reviewCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("no written reviews: says nothing about reviews rather than claiming zero or 37", () => {
    const r = rating({ count: 5, avgRating: 4.2, writtenCount: 0 });
    expect(r?.ratingCount).toBe(5);
    expect(r).not.toHaveProperty("reviewCount");
  });

  it("an older API that sends no writtenCount still gets a valid rating block", () => {
    const r = rating({ count: 5, avgRating: 4.2 });
    expect(r?.ratingCount).toBe(5);
    expect(r).not.toHaveProperty("reviewCount");
  });

  it("no approved ratings: no rating block at all", () => {
    expect(rating({ count: 0, avgRating: null, writtenCount: 0 })).toBeUndefined();
  });
});
