import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const rewardsTab = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/useAppHasRewardsTab", () => ({ useAppHasRewardsTab: rewardsTab }));

const { ShopPageClient } = await import("../ShopPageClient");

/**
 * THE SHOP PAGE IS STUDIO, FOR EVERY SHOP. The owner (2026-11-16) wanted the
 * client side redesigned "no matter what the barbers wanted", so the per-shop
 * design picker and the other six layouts are gone and whatever a shop stored
 * renders Studio.
 *
 * Pinned: every stored value (none, classic, an old design, junk) is Studio;
 * Book leads and the standing waitlist is off the top; a photo opens full
 * screen with "Book this look" that picks its service and person; the rewards
 * button leaves the page in the app; example photos exist only in the editor
 * preview.
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
  rewardsTab.mockReturnValue(false);
});

describe("every shop gets Studio, whatever design it stored", () => {
  // None stored, the old default, a retired design, and a value nothing knows.
  for (const pageDesign of [undefined, "classic", "grid", "neon-zebra"]) {
    it(`🔴 ${pageDesign ?? "none stored"}: the menu books, the work shows, and the standing waitlist is off the top`, () => {
      render(<ShopPageClient data={page({ pageDesign })} />);
      expect(screen.getByRole("link", { name: /^Book Haircut/ }).getAttribute("href")).toBe("/book/fresh?service=svc-cut");
      expect(screen.getByText("Recent work")).toBeTruthy();
      expect(screen.getAllByRole("link", { name: "Book an appointment" }).length).toBeGreaterThan(0);
      // A shop that books here offers the waitlist on its booking page.
      expect(screen.queryByRole("button", { name: "Join the waitlist" })).toBeNull();
    });
  }

  it("a shop that books elsewhere keeps its waitlist, lower down", () => {
    render(
      <ShopPageClient
        data={page({ bookingMode: "link", bookingUrl: "https://book.example/fresh", services: [], staff: [] })}
      />,
    );
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeTruthy();
  });
});

describe("a photo, full screen", () => {
  it("🔴 Book this look opens booking with that service and that person already picked", () => {
    render(<ShopPageClient data={page()} bookQuery="?cb_domain=shop.example" />);
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
    render(<ShopPageClient data={page()} />);
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
        data={page({ bookingMode: "link", bookingUrl: "https://book.example/fresh" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skin taper" }));
    const book = within(screen.getByRole("dialog")).getByRole("link", { name: "Book this look" });
    expect(book.getAttribute("href")).toBe("https://book.example/fresh");
  });
});

describe("the page served on a shop's own domain", () => {
  it("🔴 every way to book stays ON the shop's domain - only 'Powered by' leads to ChairBack", () => {
    // Served on the shop's domain, where "/" is this page and /book is its
    // booking (lib/customDomainRouting.ts): Book, a menu row, the photo's Book
    // this look and the rewards finder all stay there, so the address bar
    // never says getchairback.com. Only the powered-by line is ChairBack's.
    render(<ShopPageClient data={page()} bookPath="/book" platformOrigin="https://getchairback.com" />);
    for (const link of screen.getAllByRole("link", { name: /Book an appointment|Book with Fresh Studio/ })) {
      expect(link.getAttribute("href")).toBe("/book");
    }
    expect(screen.getByRole("link", { name: /^Book Haircut/ }).getAttribute("href")).toBe("/book?service=svc-cut");
    expect(screen.getByRole("link", { name: /Find my rewards/ }).getAttribute("href")).toBe("/my-rewards");
    expect(screen.getByRole("link", { name: /Powered by/ }).getAttribute("href")).toBe(
      "https://getchairback.com/?ref=fresh",
    );
    fireEvent.click(screen.getByRole("button", { name: "Skin taper" }));
    const book = within(screen.getByRole("dialog")).getByRole("link", { name: "Book this look" });
    expect(book.getAttribute("href")).toBe("/book?service=svc-cut&staff=st-marcus");
    for (const link of screen.getAllByRole("link")) {
      const href = link.getAttribute("href") ?? "";
      if (/Powered by/.test(link.textContent ?? "")) continue;
      expect(href.startsWith("https://getchairback.com"), href).toBe(false);
    }
  });

  it("on getchairback.com itself, the same links stay on this site", () => {
    render(<ShopPageClient data={page()} />);
    for (const link of screen.getAllByRole("link", { name: /Book an appointment|Book with Fresh Studio/ })) {
      expect(link.getAttribute("href")).toBe("/book/fresh");
    }
    expect(screen.getByRole("link", { name: /Find my rewards/ }).getAttribute("href")).toBe("/my-rewards");
    expect(screen.getByRole("link", { name: /Powered by/ }).getAttribute("href")).toBe("/?ref=fresh");
  });
});

describe("the rewards button", () => {
  const withRewards = (design: string | undefined) => (
    <ShopPageClient data={page({ pageDesign: design })} rewardsHref="/r/tok/rewards" rewardsLabel="Your rewards · 3 punches" />
  );

  for (const design of [undefined, "classic"]) {
    const name = design ?? "none stored";

    it(`🔴 ${name}: inside an app build whose Rewards tab holds it all - timer included - it leaves the page`, () => {
      nativeApp.mockReturnValue(true);
      rewardsTab.mockReturnValue(true);
      render(withRewards(design));
      expect(screen.queryByText("Your rewards · 3 punches")).toBeNull();
    });

    it(`🔴 ${name}: an older app build keeps it - its Rewards tab has no timer yet`, () => {
      nativeApp.mockReturnValue(true);
      render(withRewards(design));
      expect(screen.getByRole("link", { name: /Your rewards · 3 punches/ }).getAttribute("href")).toBe("/r/tok/rewards");
    });

    it(`${name}: on the web it stays - there it is the way to the card`, () => {
      render(withRewards(design));
      expect(screen.getByRole("link", { name: /Your rewards · 3 punches/ })).toBeTruthy();
    });
  }
});

describe("a review link", () => {
  // The "Switching from Booksy or TheCut" guide hands the shop a review link,
  // /s/<slug>#reviews, to send its regulars. It must land on the reviews.
  it("🔴 /s/<slug>#reviews has somewhere to land", () => {
    window.history.replaceState(null, "", "#reviews");
    try {
      render(<ShopPageClient data={page()} />);
      expect(document.getElementById("reviews")).not.toBeNull();
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });
});

describe("studio", () => {
  it("every row of the menu books that service, and everyone on the team books with them", () => {
    render(<ShopPageClient data={page()} />);
    expect(screen.getByRole("link", { name: /^Book Haircut/ }).getAttribute("href")).toBe("/book/fresh?service=svc-cut");
    expect(screen.getByRole("link", { name: /^Book Beard Trim/ }).getAttribute("href")).toBe("/book/fresh?service=svc-beard");
    expect(screen.getByRole("link", { name: "Book with Marcus" }).getAttribute("href")).toBe("/book/fresh?staff=st-marcus");
    expect(screen.getByRole("link", { name: "Book with Dre" }).getAttribute("href")).toBe("/book/fresh?staff=st-dre");
  });

  it("a team of one is the shop itself, so there is no team to pick from", () => {
    render(<ShopPageClient data={page({ staff: [STAFF[0]!] })} />);
    expect(screen.queryByText("The team")).toBeNull();
  });

  it("🔴 a shop that hides its services: no menu, no pinned price bar, one Book button under the header", () => {
    render(<ShopPageClient data={page({ showServices: false })} />);
    expect(screen.queryByText("Services")).toBeNull();
    expect(screen.queryByText("Beard Trim")).toBeNull();
    expect(screen.queryByText("From")).toBeNull();
    const book = screen.getAllByRole("link", { name: "Book an appointment" });
    expect(book).toHaveLength(1);
    expect(book[0]!.getAttribute("href")).toBe("/book/fresh");
  });

  it("an older payload with no showServices still shows the menu", () => {
    const data = page();
    delete (data as { showServices?: boolean }).showServices;
    render(<ShopPageClient data={data} />);
    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.getByText("From")).toBeTruthy();
  });

  it("🔴 Book is pinned once, with the lowest price beside it - not repeated at the top", () => {
    render(<ShopPageClient data={page()} />);
    const book = screen.getAllByRole("link", { name: "Book an appointment" });
    expect(book).toHaveLength(1);
    expect(book[0]!.getAttribute("href")).toBe("/book/fresh");
    expect(book[0]!.getAttribute("data-tour")).toBe("book-cta");
    // Beard Trim's $20, not the first service's $35.
    expect(screen.getByText("From").parentElement?.textContent).toBe("From$20");
  });

  it("a shop with no way to book online gets the request form in the page, and no pinned bar", () => {
    render(
      <ShopPageClient
        data={page({ bookingMode: "link", bookingUrl: null, services: [], staff: [] })}
      />,
    );
    expect(screen.getByRole("button", { name: "Send request" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Book an appointment" })).toBeNull();
    expect(screen.queryByText("From")).toBeNull();
  });

  it("offers directions, a text and Instagram only when the shop has them", () => {
    const { unmount } = render(<ShopPageClient data={page()} />);
    expect(screen.queryByRole("link", { name: /Directions to/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Text Fresh Studio" })).toBeNull();
    unmount();
    render(
      <ShopPageClient
        data={page({
          showDirections: true,
          addressStreet: "12 Main St",
          addressCity: "Hoboken",
          addressRegion: "NJ",
          instagramHandle: "freshstudio",
        })}
      />,
    );
    const directions = screen.getByRole("link", { name: "Directions to Fresh Studio" }).getAttribute("href")!;
    // The address alone: the shop's name in the search made the map guess.
    expect(decodeURIComponent(directions)).toContain("query=12 Main St, Hoboken, NJ");
    expect(decodeURIComponent(directions)).not.toContain("Fresh Studio");
    expect(screen.getByRole("link", { name: "Fresh Studio on Instagram" }).getAttribute("href")).toBe(
      "https://instagram.com/freshstudio",
    );
    expect(screen.queryByRole("link", { name: "Text Fresh Studio" })).toBeNull();
    expect(screen.getByText("Hoboken, NJ")).toBeTruthy();
  });

  it("🔴 Directions is off until the barber turns it on, even with a full address", () => {
    const full = { addressStreet: "12 Main St", addressCity: "Hoboken", addressRegion: "NJ" };
    const { unmount } = render(<ShopPageClient data={page(full)} />);
    expect(screen.queryByRole("link", { name: /Directions to/ })).toBeNull();
    unmount();
    // An older payload without the switch: off as well.
    const { unmount: u2 } = render(<ShopPageClient data={page({ ...full, showDirections: undefined })} />);
    expect(screen.queryByRole("link", { name: /Directions to/ })).toBeNull();
    u2();
    render(<ShopPageClient data={page({ ...full, showDirections: true })} />);
    expect(screen.getByRole("link", { name: "Directions to Fresh Studio" })).toBeTruthy();
  });

  it("🔴 a city alone, or a private street, gives no Directions to guess at", () => {
    // A private address reaches the page as city + region only.
    render(<ShopPageClient data={page({ showDirections: true, addressStreet: null, addressCity: "Paterson", addressRegion: "NJ" })} />);
    expect(screen.queryByRole("link", { name: /Directions to/ })).toBeNull();
  });

  it("🔴 an app build that would open the map inside itself gets no Directions", async () => {
    const w = window as unknown as { __cbNative?: object; ReactNativeWebView?: unknown };
    w.ReactNativeWebView = { postMessage() {} };
    w.__cbNative = { openAuth: true };
    try {
      const full = { showDirections: true, addressStreet: "12 Main St", addressCity: "Hoboken" };
      const { unmount } = render(<ShopPageClient data={page(full)} />);
      expect(screen.queryByRole("link", { name: /Directions to/ })).toBeNull();
      unmount();
      w.__cbNative = { openAuth: true, externalMaps: true };
      render(<ShopPageClient data={page(full)} />);
      expect(screen.getByRole("link", { name: "Directions to Fresh Studio" })).toBeTruthy();
    } finally {
      delete w.__cbNative;
      delete w.ReactNativeWebView;
    }
  });

  describe("Share", () => {
    const realShare = Object.getOwnPropertyDescriptor(navigator, "share");
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (realShare) Object.defineProperty(navigator, "share", realShare);
      else delete (navigator as { share?: unknown }).share;
      if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
      window.history.replaceState(null, "", "/");
    });

    it("🔴 shares the shop's page by its name, never the address bar a client's rewards link put them on", async () => {
      const share = vi.fn(async (_data: ShareData) => {});
      Object.defineProperty(navigator, "share", { value: share, configurable: true });
      window.history.replaceState(null, "", "/r/secret-token-123/shop?ref=x");
      render(<ShopPageClient data={page()} rewardsHref="/r/secret-token-123/rewards" />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const sent = share.mock.calls[0]![0];
      expect(sent).toEqual({ title: "Fresh Studio", url: `${window.location.origin}/s/fresh` });
      expect(JSON.stringify(sent)).not.toContain("secret-token");
    });

    it("on the shop's own domain the shared link is the domain itself - the address the owner hands out", async () => {
      const share = vi.fn(async (_data: ShareData) => {});
      Object.defineProperty(navigator, "share", { value: share, configurable: true });
      render(<ShopPageClient data={page()} bookPath="/book" platformOrigin="https://getchairback.com" />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      expect(share.mock.calls[0]![0].url).toBe(window.location.origin);
    });

    it("with no share sheet, copies the link and says so", async () => {
      delete (navigator as { share?: unknown }).share;
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<ShopPageClient data={page()} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await screen.findByText("Link copied");
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/fresh`);
    });

    it("does nothing in the editor preview", () => {
      const share = vi.fn(async () => {});
      Object.defineProperty(navigator, "share", { value: share, configurable: true });
      render(<ShopPageClient data={page()} preview />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(share).not.toHaveBeenCalled();
    });
  });
});

describe("example photos", () => {
  it("🔴 only in the editor preview, labeled - the live page never shows work the shop didn't post", () => {
    const { unmount } = render(<ShopPageClient data={page({ gallery: [] })} preview />);
    expect(screen.getByText("Example photos — yours will appear here")).toBeTruthy();
    unmount();
    render(<ShopPageClient data={page({ gallery: [] })} />);
    expect(screen.queryByText(/Example photos/)).toBeNull();
    expect(screen.queryByText("The work")).toBeNull();
  });
});
