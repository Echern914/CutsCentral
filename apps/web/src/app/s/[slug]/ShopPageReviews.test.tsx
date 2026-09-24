import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ShopPageData } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  submitReviewAction: vi.fn(async () => ({ ok: true })),
  submitRequestAction: vi.fn(async () => ({ ok: true })),
  joinWaitlistAction: vi.fn(async () => ({ ok: true })),
}));

const { ShopPageClient } = await import("./ShopPageClient");

/**
 * THE REVIEWS SECTION: CARDS NEED WORDS, THE STARS COUNT EVERYONE.
 *
 * Drick: "Reviews should only show the ones with words." A star-only rating
 * rendered as a card with nothing to read. It is still a real rating,
 * so the average keeps counting it - and the header now calls that number
 * "ratings", which is what makes "4.9 · 37 ratings" above twelve cards honest.
 *
 * The API filters the cards already (reviews.test.ts); the page filters again
 * because the web and the API deploy separately, and an older API would still
 * send star-only rows.
 */
function page(over: Partial<ShopPageData>): ShopPageData {
  return {
    name: "Fresh Studio",
    slug: "fresh",
    bio: null,
    industry: "salon",
    serviceNoun: null,
    receptionistNumber: null,
    theme: "classic",
    logoUrl: null,
    heroImageUrl: null,
    accentColor: null,
    instagramHandle: null,
    googleReviewUrl: null,
    hoursText: null,
    addressStreet: null,
    addressCity: null,
    addressRegion: null,
    addressPostal: null,
    gallery: [],
    fontKey: null,
    layoutStyle: null,
    sectionOrder: ["reviews"],
    bookingUrl: "https://book.example/fresh",
    bookingMode: "link",
    takesRequests: false,
    waitlistEnabled: false,
    punchesPerVisit: 1,
    rewards: [],
    promotions: [],
    reviews: [],
    reviewSummary: { count: 0, avgRating: null, writtenCount: 0 },
    ...over,
  };
}

const review = (id: string, rating: number, authorName: string, body: string | null) => ({
  id,
  rating,
  authorName,
  body,
  createdAt: "2026-09-20T15:00:00.000Z",
});

describe("the header counts ratings", () => {
  it("🔴 labels the count as ratings, and it can exceed the cards", () => {
    render(
      <ShopPageClient
        data={page({
          reviews: [review("r1", 5, "Marcus", "Best in town")],
          reviewSummary: { count: 37, avgRating: 4.86, writtenCount: 1 },
        })}
      />,
    );
    expect(screen.getByText("4.9")).toBeTruthy();
    expect(screen.getByText("· 37 ratings")).toBeTruthy();
    expect(screen.queryByText(/37 reviews/)).toBeNull();
  });

  it("one rating is singular", () => {
    render(<ShopPageClient data={page({ reviewSummary: { count: 1, avgRating: 4, writtenCount: 0 } })} />);
    expect(screen.getByText("· 1 rating")).toBeTruthy();
  });

  it("🔴 a shop whose ratings are all star-only still shows its average", () => {
    // No cards at all - but three real ratings. The old header hid itself
    // whenever there were no cards, which would now hide real stars.
    render(<ShopPageClient data={page({ reviewSummary: { count: 3, avgRating: 3.67, writtenCount: 0 } })} />);
    expect(screen.getByText("3.7")).toBeTruthy();
    expect(screen.getByText("· 3 ratings")).toBeTruthy();
  });

  it("no ratings: no header", () => {
    render(<ShopPageClient data={page({})} />);
    expect(screen.queryByText(/ratings?$/)).toBeNull();
  });
});

describe("the cards", () => {
  it("🔴 a review without words is never a card, even from an older API", () => {
    render(
      <ShopPageClient
        data={page({
          reviews: [
            review("r1", 5, "Marcus", "Best in town"),
            review("r2", 2, "Stars Only", null),
            review("r3", 4, "Blank", "   "),
          ],
          reviewSummary: { count: 3, avgRating: 3.67 },
        })}
      />,
    );
    expect(screen.getByText("Best in town")).toBeTruthy();
    expect(screen.getByText("Marcus")).toBeTruthy();
    expect(screen.queryByText("Stars Only")).toBeNull();
    expect(screen.queryByText("Blank")).toBeNull();
  });
});
