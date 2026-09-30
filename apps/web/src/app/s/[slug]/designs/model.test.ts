import { describe, expect, it } from "vitest";
import type { PagePhoto, ShopPageData } from "../page";
import {
  addedLabel,
  bookPickedHref,
  durationText,
  feedWithReviews,
  monogram,
  newestFirst,
  photoMeta,
  priceText,
  servicePhotos,
} from "./model";
import { photosToShow } from "./examples";

const data = { slug: "fresh" } as ShopPageData;

describe("booking with a photo's picks", () => {
  const native = { data, bookIsNative: true, bookHref: "/book/fresh", bookQuery: undefined };

  it("🔴 carries the service and the person to the booking page, which validates them", () => {
    expect(bookPickedHref(native, { serviceId: "svc", staffId: "st" })).toBe("/book/fresh?service=svc&staff=st");
    expect(bookPickedHref(native, { serviceId: "svc" })).toBe("/book/fresh?service=svc");
    expect(bookPickedHref(native, {})).toBe("/book/fresh");
  });

  it("keeps a custom-domain visit's same-shop marker", () => {
    const viaDomain = { ...native, bookHref: "/book/fresh?cb_domain=a.com", bookQuery: "?cb_domain=a.com" };
    expect(bookPickedHref(viaDomain, { serviceId: "svc" })).toBe("/book/fresh?cb_domain=a.com&service=svc");
  });

  it("an outside booking site gets its own link as it is - our ids mean nothing there", () => {
    const outside = { data, bookIsNative: false, bookHref: "https://book.example/x", bookQuery: undefined };
    expect(bookPickedHref(outside, { serviceId: "svc", staffId: "st" })).toBe("https://book.example/x");
  });

  it("no booking destination, no link", () => {
    expect(bookPickedHref({ data, bookIsNative: false, bookHref: null }, { serviceId: "svc" })).toBeNull();
  });
});

describe("the words", () => {
  it("prices and lengths the way a menu says them", () => {
    expect(priceText(35)).toBe("$35");
    expect(priceText(35.5)).toBe("$35.50");
    expect(priceText(null)).toBeNull();
    expect(durationText(30)).toBe("30 min");
    expect(durationText(60)).toBe("1 hr");
    expect(durationText(75)).toBe("1 hr 15 min");
  });

  it("when a photo went up, as a person says it", () => {
    const now = new Date(2026, 8, 30, 15, 0);
    const at = (y: number, m: number, d: number, h = 10) => new Date(y, m, d, h).toISOString();
    expect(addedLabel(at(2026, 8, 30, 9), now)).toBe("Today");
    expect(addedLabel(at(2026, 8, 29, 23), now)).toBe("Yesterday");
    expect(addedLabel(at(2026, 8, 27), now)).toBe("3 days ago");
    expect(addedLabel(at(2026, 8, 20), now)).toBe("1 week ago");
    expect(addedLabel(at(2026, 8, 9), now)).toBe("3 weeks ago");
    expect(addedLabel(at(2026, 7, 1), now)).not.toMatch(/ago/);
    expect(addedLabel(undefined, now)).toBeNull();
    expect(addedLabel("not a date", now)).toBeNull();
  });

  it("a coin with no logo shows the shop's initials", () => {
    expect(monogram("Fade District")).toBe("FD");
    expect(monogram("  drickcuttinup ")).toBe("DR");
  });

  it("what a photo is, in one line - only the parts it has", () => {
    const shop = {
      services: [{ id: "s", name: "Haircut", description: null, imageUrl: null, durationMin: 30, price: 35 }],
      staff: [{ id: "p", name: "Marcus", imageUrl: null }],
    } as ShopPageData;
    expect(photoMeta(shop, { url: "u", serviceId: "s", staffId: "p" })).toBe("Haircut · 30 min · $35 · by Marcus");
    expect(photoMeta(shop, { url: "u", staffId: "p" })).toBe("by Marcus");
    expect(photoMeta(shop, { url: "u", serviceId: "gone" })).toBeNull();
  });
});

describe("ordering the work", () => {
  const p = (url: string, addedAt?: string): PagePhoto => ({ url, ...(addedAt ? { addedAt } : {}) });

  it("🔴 newest first; photos from before dates existed follow, in the owner's order", () => {
    const photos = [p("old-a"), p("mid", "2026-09-20T10:00:00Z"), p("old-b"), p("new", "2026-09-29T10:00:00Z")];
    expect(newestFirst(photos).map((x) => x.url)).toEqual(["new", "mid", "old-a", "old-b"]);
  });

  it("a written review after every second photo, the rest after the last one", () => {
    const review = (id: string, body: string | null) => ({ id, rating: 5, body, authorName: null, createdAt: "2026-09-01T00:00:00Z" });
    const feed = feedWithReviews(
      [p("1"), p("2"), p("3")],
      [review("a", "Great"), review("stars-only", null), review("b", "Clean"), review("c", "Fast")],
    );
    expect(feed.map((i) => (i.kind === "photo" ? i.photo.url : `r:${i.review.id}`))).toEqual([
      "1",
      "2",
      "r:a",
      "3",
      "r:b",
      "r:c",
    ]);
  });

  it("a service's photos: its own picture first, then the gallery's photos of it", () => {
    const service = { id: "s", name: "Haircut", description: null, imageUrl: "own.jpg", durationMin: 30, price: 35 };
    const photos = [{ url: "a.jpg", serviceId: "s" }, { url: "b.jpg", serviceId: "t" }, { url: "own.jpg", serviceId: "s" }];
    expect(servicePhotos(service, photos).map((x) => x.url)).toEqual(["a.jpg", "own.jpg"]);
    expect(servicePhotos({ ...service, imageUrl: "own2.jpg" }, photos).map((x) => x.url)).toEqual([
      "own2.jpg",
      "a.jpg",
      "own.jpg",
    ]);
  });
});

describe("example photos", () => {
  it("🔴 only in the preview, only while the shop has none", () => {
    expect(photosToShow({ gallery: [], industry: "barber" }, false)).toEqual({ photos: [], examples: false });
    expect(photosToShow({ gallery: [], industry: "barber" }, true).examples).toBe(true);
    const own = [{ url: "mine.jpg" }];
    expect(photosToShow({ gallery: own, industry: "barber" }, true)).toEqual({ photos: own, examples: false });
  });

  it("a business that isn't a barbershop gets plain placeholders, not another trade's work", () => {
    const { photos } = photosToShow({ gallery: [], industry: "nails" }, true);
    expect(photos.every((x) => x.url.includes("neutral") && !x.caption)).toBe(true);
  });
});
