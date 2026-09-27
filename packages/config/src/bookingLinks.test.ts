import { describe, expect, it } from "vitest";
import { bookNowUrl, isUsableBookingLink, shareUrl, type BookingLinkShop } from "./bookingLinks.js";

/**
 * Where "Book" goes, for every booking mode - the rule nudges, win-backs,
 * promotions, the rewards page, the saved-shops list, broadcasts and the
 * dashboard's own link and QR code now share.
 */
const BASE = "https://app.example/";
const shop = (over: Partial<BookingLinkShop> = {}): BookingLinkShop => ({
  bookingMode: "native",
  bookingUrl: null,
  slug: "fresh-cuts",
  publicPageEnabled: true,
  ...over,
});

describe("bookNowUrl", () => {
  it("sends a ChairBack-booking shop to its own booking page", () => {
    expect(bookNowUrl(shop(), BASE)).toBe("https://app.example/book/fresh-cuts");
  });

  it("🔴 ignores an old Acuity link a switched shop still has saved", () => {
    expect(bookNowUrl(shop({ bookingUrl: "https://old.as.me/schedule.php" }), BASE)).toBe(
      "https://app.example/book/fresh-cuts",
    );
  });

  it("has nowhere to send anyone when the page is off or there is no handle", () => {
    expect(bookNowUrl(shop({ publicPageEnabled: false }), BASE)).toBeNull();
    expect(bookNowUrl(shop({ slug: null }), BASE)).toBeNull();
  });

  for (const mode of ["acuity", "square", "link"]) {
    it(`${mode}: uses the saved link, trimmed, when a customer can open it`, () => {
      expect(bookNowUrl(shop({ bookingMode: mode, bookingUrl: "  https://x.as.me/s " }), BASE)).toBe(
        "https://x.as.me/s",
      );
    });

    it(`${mode}: is null - never a /book/ page that does not exist - without one`, () => {
      expect(bookNowUrl(shop({ bookingMode: mode, bookingUrl: null }), BASE)).toBeNull();
      expect(bookNowUrl(shop({ bookingMode: mode, bookingUrl: "not a link" }), BASE)).toBeNull();
    });
  }
});

describe("shareUrl - the link a shop hands out", () => {
  it("is the booking page on ChairBack booking", () => {
    expect(shareUrl(shop(), BASE)).toBe("https://app.example/book/fresh-cuts");
  });

  it("is the shop's page otherwise, so a printed code survives a later switch", () => {
    for (const mode of ["acuity", "square", "link"]) {
      expect(shareUrl(shop({ bookingMode: mode, bookingUrl: "https://x.as.me" }), BASE)).toBe(
        "https://app.example/s/fresh-cuts",
      );
    }
  });

  it("does not exist until the shop has a handle", () => {
    expect(shareUrl(shop({ slug: null }), BASE)).toBeNull();
  });
});

describe("isUsableBookingLink", () => {
  it("accepts http(s) links a customer can open", () => {
    expect(isUsableBookingLink("https://studio.as.me/schedule.php")).toBe(true);
    expect(isUsableBookingLink(" http://booksy.com/x ")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const bad of [null, undefined, "", "   ", "not a link", "javascript:alert(1)", "ftp://x.y", "https://"]) {
      expect(isUsableBookingLink(bad), String(bad)).toBe(false);
    }
  });
});
