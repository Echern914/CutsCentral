import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PagePhoto, ShopPageData } from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../actions", () => ({
  submitReviewAction: vi.fn(async () => ({ ok: true })),
  submitRequestAction: vi.fn(async () => ({ ok: true })),
  joinWaitlistAction: vi.fn(async () => ({ ok: true })),
}));
const nativeApp = vi.hoisted(() => vi.fn(() => false as boolean | null));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: nativeApp }));

const { ShopPageClient } = await import("../ShopPageClient");

/**
 * PAGE DESIGNS. The owner: "have them as templates... keep the one that
 * everyone has been using now as the default". And, of the circled buttons,
 * "Gallery here and move that to customer side".
 *
 * Pinned: no design (or a junk one) is the classic page, untouched; every other
 * design leads with Book and the work and drops the standing waitlist from the
 * top; a photo opens full screen with "Book this look" that picks its service
 * and person; the rewards button leaves the page in the app; example photos
 * exist only in the editor preview.
 */
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const SERVICES = [
  { id: "svc-cut", name: "Haircut", description: null, imageUrl: null, durationMin: 30, price: 35 },
  { id: "svc-beard", name: "Beard Trim", description: "Shape and line", imageUrl: null, durationMin: 15, price: 20 },
];
const STAFF = [
  { id: "st-marcus", name: "Marcus", imageUrl: null },
  { id: "st-dre", name: "Dre", imageUrl: null },
];
const PHOTOS: PagePhoto[] = [
  { url: "https://img.test/1.jpg", caption: "Skin taper", serviceId: "svc-cut", staffId: "st-marcus", addedAt: ago(2) },
  { url: "https://img.test/2.jpg", caption: "Hard part", serviceId: "svc-cut", staffId: "st-dre", addedAt: ago(5) },
  { url: "https://img.test/3.jpg", serviceId: "svc-beard", addedAt: ago(1) },
  { url: "https://img.test/4.jpg", caption: "Waves" },
];

function page(over: Partial<ShopPageData> = {}): ShopPageData {
  return {
    name: "Fresh Studio",
    slug: "fresh",
    bio: null,
    industry: "barber",
    serviceNoun: null,
    receptionistNumber: null,
    theme: "blade",
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
    gallery: PHOTOS,
    services: SERVICES,
    staff: STAFF,
    fontKey: null,
    layoutStyle: null,
    sectionOrder: ["gallery", "reviews"],
    bookingUrl: null,
    bookingMode: "native",
    takesRequests: false,
    waitlistEnabled: true,
    punchesPerVisit: 1,
    rewards: [],
    promotions: [],
    reviews: [],
    reviewSummary: { count: 0, avgRating: null, writtenCount: 0 },
    ...over,
  };
}

beforeEach(() => {
  nativeApp.mockReturnValue(false);
});

describe("the design a shop gets", () => {
  it("🔴 none stored is classic: the waitlist and the rewards button stay where they always were", () => {
    render(
      <ShopPageClient
        data={page({ pageDesign: undefined })}
        rewardsHref="/r/tok/rewards"
        rewardsLabel="Your rewards · 3 punches"
      />,
    );
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Your rewards · 3 punches/ })).toBeTruthy();
    // Classic's own gallery, not a design's grid: no photo opens a viewer.
    expect(screen.getByText("The work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skin taper" })).toBeNull();
  });

  it("a design that doesn't exist is classic too", () => {
    render(<ShopPageClient data={page({ pageDesign: "neon-zebra" })} />);
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeTruthy();
  });
});

describe("every new design", () => {
  for (const design of ["grid", "lookbook", "reel", "profile", "fresh"]) {
    it(`🔴 ${design}: Book leads, the work shows, and the standing waitlist is off the top`, () => {
      render(<ShopPageClient data={page({ pageDesign: design })} />);
      expect(screen.getAllByRole("link", { name: "Book an appointment" }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /Skin taper|Hard part|Waves/ }).length).toBeGreaterThan(0);
      // A shop that books here offers the waitlist on its booking page.
      expect(screen.queryByRole("button", { name: "Join the waitlist" })).toBeNull();
    });
  }

  it("a shop that books elsewhere keeps its waitlist, lower down", () => {
    render(
      <ShopPageClient
        data={page({ pageDesign: "grid", bookingMode: "link", bookingUrl: "https://book.example/fresh", services: [], staff: [] })}
      />,
    );
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeTruthy();
  });
});

describe("a photo, full screen", () => {
  it("🔴 Book this look opens booking with that service and that person already picked", () => {
    render(<ShopPageClient data={page({ pageDesign: "grid" })} bookQuery="?cb_domain=shop.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Skin taper" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Skin taper" })).toBeTruthy();
    expect(within(dialog).getByText("Haircut · 30 min · $35 · by Marcus")).toBeTruthy();
    const book = within(dialog).getByRole("link", { name: "Book this look" });
    // The custom-domain marker survives, and both picks ride along.
    expect(book.getAttribute("href")).toBe("/book/fresh?cb_domain=shop.example&service=svc-cut&staff=st-marcus");
    expect(within(dialog).getByText("Opens booking with Haircut and Marcus already picked.")).toBeTruthy();
  });

  it("steps through the photos, and Escape closes it", () => {
    render(<ShopPageClient data={page({ pageDesign: "grid" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Skin taper" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next photo" }));
    expect(within(dialog).getByRole("heading", { name: "Hard part" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a shop that books elsewhere sends the photo to its own booking link, as it is", () => {
    render(
      <ShopPageClient
        data={page({ pageDesign: "grid", bookingMode: "link", bookingUrl: "https://book.example/fresh" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skin taper" }));
    const book = within(screen.getByRole("dialog")).getByRole("link", { name: "Book this look" });
    expect(book.getAttribute("href")).toBe("https://book.example/fresh");
  });
});

describe("the rewards button", () => {
  const withRewards = (design: string) => (
    <ShopPageClient data={page({ pageDesign: design })} rewardsHref="/r/tok/rewards" rewardsLabel="Your rewards · 3 punches" />
  );

  it("🔴 in the app it leaves the page - the app's Rewards tab holds every shop's card", () => {
    nativeApp.mockReturnValue(true);
    render(withRewards("grid"));
    expect(screen.queryByText("Your rewards · 3 punches")).toBeNull();
  });

  it("on the web it stays, small, for a client without the app", () => {
    render(withRewards("grid"));
    expect(screen.getByRole("link", { name: /Your rewards · 3 punches/ }).getAttribute("href")).toBe("/r/tok/rewards");
  });
});

describe("the designs' own jobs", () => {
  it("lookbook: every service carries its photos and its own Book", () => {
    render(<ShopPageClient data={page({ pageDesign: "lookbook" })} />);
    expect(screen.getByRole("link", { name: "Book Haircut" }).getAttribute("href")).toBe("/book/fresh?service=svc-cut");
    expect(screen.getByRole("link", { name: "Book Beard Trim" }).getAttribute("href")).toBe("/book/fresh?service=svc-beard");
    expect(screen.getByRole("button", { name: "Skin taper" })).toBeTruthy();
    // A photo that names no service follows under More work.
    expect(screen.getByText("More work")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Waves" })).toBeTruthy();
  });

  it("reel: plays the first photos and steps on a tap; Book is pinned, not repeated", () => {
    render(<ShopPageClient data={page({ pageDesign: "reel" })} />);
    expect(screen.getByRole("img", { name: "Skin taper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("img", { name: "Hard part" })).toBeTruthy();
    // The pinned bar, and the footer's "Book with" - no second top button.
    expect(screen.getAllByRole("link", { name: "Book an appointment" })).toHaveLength(1);
  });

  it("profile: tabs, and the work filters by who did it", () => {
    render(<ShopPageClient data={page({ pageDesign: "profile" })} />);
    expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Dre" }));
    expect(screen.queryByRole("button", { name: "Skin taper" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hard part" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Services" }));
    expect(screen.getByRole("link", { name: "Book Beard Trim" }).getAttribute("href")).toBe("/book/fresh?service=svc-beard");
  });

  it("fresh: newest first, dated, with written reviews between the photos", () => {
    render(
      <ShopPageClient
        data={page({
          pageDesign: "fresh",
          reviews: [{ id: "r1", rating: 5, body: "Best in town", authorName: "Chris T.", createdAt: ago(3) }],
          reviewSummary: { count: 1, avgRating: 5, writtenCount: 1 },
        })}
      />,
    );
    const shots = screen
      .getAllByRole("button", { name: /Beard Trim|Skin taper|Hard part|Waves/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(shots).toEqual(["Beard Trim", "Skin taper", "Hard part", "Waves"]);
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText("2 days ago")).toBeTruthy();
    expect(screen.getByText("“Best in town”")).toBeTruthy();
  });

  it("fresh: reviews the shop hid stay out of the feed", () => {
    render(
      <ShopPageClient
        data={page({
          pageDesign: "fresh",
          sectionOrder: ["hours"],
          reviews: [{ id: "r1", rating: 5, body: "Best in town", authorName: "Chris T.", createdAt: ago(3) }],
          reviewSummary: { count: 1, avgRating: 5, writtenCount: 1 },
        })}
      />,
    );
    expect(screen.queryByText("“Best in town”")).toBeNull();
  });
});

describe("example photos", () => {
  it("🔴 only in the editor preview, labeled - the live page never shows work the shop didn't post", () => {
    const { unmount } = render(<ShopPageClient data={page({ pageDesign: "grid", gallery: [] })} preview />);
    expect(screen.getByText("Example photos — yours will appear here")).toBeTruthy();
    unmount();
    render(<ShopPageClient data={page({ pageDesign: "grid", gallery: [] })} />);
    expect(screen.queryByText(/Example photos/)).toBeNull();
    expect(screen.queryByText("The work")).toBeNull();
  });
});
