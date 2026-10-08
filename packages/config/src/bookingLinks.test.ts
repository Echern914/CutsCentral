import { describe, expect, it } from "vitest";
import {
  bookNowUrl,
  isUsableBookingLink,
  messageBookingUrl,
  showsRequestForm,
  type BookingLinkShop,
} from "./bookingLinks.js";

describe("showsRequestForm - the shop page and the request route share it", () => {
  const shop = (bookingMode: string, bookingUrl: string | null, takesRequests: boolean) =>
    showsRequestForm({ bookingMode, bookingUrl, takesRequests });
  it("🔴 a shop with no way to book shows the form even with requests off", () => {
    expect(shop("link", null, false)).toBe(true);
    expect(shop("link", "not a link", false)).toBe(true);
  });
  it("a shop with a real booking link shows it only when requests are on", () => {
    expect(shop("link", "https://book.example/x", false)).toBe(false);
    expect(shop("link", "https://book.example/x", true)).toBe(true);
  });
  it("ChairBack booking never shows it", () => {
    expect(shop("native", null, true)).toBe(false);
    expect(shop("native", null, false)).toBe(false);
  });
});

/**
 * Where "Book" goes, for every booking mode - the rule nudges, win-backs,
 * promotions, the rebook push, the rewards page and the saved-shops list share.
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

describe("messageBookingUrl - the Book link a text or push carries", () => {
  it("follows bookNowUrl, so a switched shop's old Acuity link is never sent", () => {
    expect(messageBookingUrl(shop({ bookingUrl: "https://old.as.me/schedule.php" }), BASE)).toBe(
      "https://app.example/book/fresh-cuts",
    );
    expect(messageBookingUrl(shop({ bookingMode: "acuity", bookingUrl: "https://x.as.me" }), BASE)).toBe(
      "https://x.as.me",
    );
    expect(messageBookingUrl(shop({ bookingMode: "acuity", bookingUrl: null }), BASE)).toBeNull();
  });

  it("leaves a ChairBack-booking shop that never saved a link on the message it always sent", () => {
    expect(messageBookingUrl(shop({ bookingUrl: null }), BASE)).toBeNull();
    expect(messageBookingUrl(shop({ bookingUrl: "not a link" }), BASE)).toBeNull();
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
