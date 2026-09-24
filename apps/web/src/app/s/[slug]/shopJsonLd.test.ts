import { describe, expect, it } from "vitest";
import { shopJsonLd } from "./shopJsonLd";
import type { ShopPageData } from "./page";

/**
 * The rating Google reads off the shop page.
 *
 * Once star-only ratings stopped being shown as cards, "ratings" and "reviews"
 * became different numbers: the average covers every approved rating, while
 * only the ones with words are reviews on the page. Structured data claiming
 * 37 reviews over a page that shows 12 is exactly the mismatch that gets
 * markup ignored, so each number has to go in the field that means it.
 */
function page(reviewSummary: ShopPageData["reviewSummary"]): ShopPageData {
  return {
    name: "Fresh Studio",
    slug: "fresh",
    industry: "salon",
    bio: null,
    logoUrl: null,
    receptionistNumber: null,
    addressStreet: null,
    addressCity: null,
    addressRegion: null,
    addressPostal: null,
    reviews: [],
    reviewSummary,
  } as unknown as ShopPageData;
}

const rating = (ld: Record<string, unknown>) =>
  ld.aggregateRating as Record<string, unknown> | undefined;

describe("aggregateRating", () => {
  it("🔴 ratingCount is every approved rating; reviewCount only the ones with words", () => {
    const r = rating(shopJsonLd(page({ count: 37, avgRating: 4.8649, writtenCount: 12 })));
    expect(r).toMatchObject({
      "@type": "AggregateRating",
      ratingValue: 4.86,
      ratingCount: 37,
      reviewCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("no written reviews: says nothing about reviews rather than claiming zero or 37", () => {
    const r = rating(shopJsonLd(page({ count: 5, avgRating: 4.2, writtenCount: 0 })));
    expect(r?.ratingCount).toBe(5);
    expect(r).not.toHaveProperty("reviewCount");
  });

  it("an older API that sends no writtenCount still gets a valid rating block", () => {
    const r = rating(shopJsonLd(page({ count: 5, avgRating: 4.2 })));
    expect(r?.ratingCount).toBe(5);
    expect(r).not.toHaveProperty("reviewCount");
  });

  it("no approved ratings: no rating block at all", () => {
    expect(rating(shopJsonLd(page({ count: 0, avgRating: null, writtenCount: 0 })))).toBeUndefined();
  });
});
