import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GetTheApp } from "./GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { track } from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const tracked = vi.mocked(track);

/**
 * The banner's whole job is knowing when to say NOTHING. Every assertion here
 * is about a case where showing it would be wrong.
 */

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function setUA(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  tracked.mockClear();
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

afterEach(() => {
  localStorage.clear();
});

describe("GetTheApp", () => {
  it("offers the app to an iOS browser that is not Safari", async () => {
    setUA(IPHONE_CHROME);
    render(<GetTheApp surface="booking" />);
    expect(await screen.findByText(/get the app/i)).toBeTruthy();
    // Per-surface copy, not one generic line.
    expect(screen.getByText(/book faster next time/i)).toBeTruthy();
  });

  it("🔴 OFFERS THE APP IN iOS SAFARI - this is the QR-scan path", async () => {
    // This assertion used to be its exact opposite ("says nothing in iOS
    // Safari - Apple own banner is already there"), and that rule is what
    // hid this card from almost everyone it was written for. A QR code
    // scanned with the iPhone Camera opens in SAFARI. Apple banner is
    // dismissible once per domain forever, so a customer who ever swiped it
    // away had no install affordance left on any shop page.
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="booking" />);
    expect(await screen.findByText(/book faster next time/i)).toBeTruthy();
  });

  it("🔴 says nothing on ANDROID - there is no Play Store listing to send them to", () => {
    // The rewards banner fell back to the iOS App Store here, which opens a
    // page an Android customer cannot install from: worse than silence,
    // because it reads as the product being broken.
    setUA(ANDROID_CHROME);
    const { container } = render(<GetTheApp surface="booking" />);
    expect(container.textContent).toBe("");
  });

  it("says nothing on desktop - a store link is for a phone", () => {
    setUA(DESKTOP);
    const { container } = render(<GetTheApp surface="shop" />);
    expect(container.textContent).toBe("");
  });

  it("🔴 says nothing inside the native app - they already have it", () => {
    setUA(IPHONE_CHROME);
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: () => {},
    };
    const { container } = render(<GetTheApp surface="line" />);
    expect(container.textContent).toBe("");
  });

  it("stays dismissed once dismissed, per device", () => {
    setUA(IPHONE_CHROME);
    localStorage.setItem("cb_get_app_dismissed", "1");
    const { container } = render(<GetTheApp surface="manage" />);
    expect(container.textContent).toBe("");
  });

  it("links to the real App Store listing, from config rather than an env var", async () => {
    setUA(IPHONE_CHROME);
    render(<GetTheApp surface="line" />);
    const link = (await screen.findByText(/get the app/i)) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/apps\.apple\.com/);
  });

  it("🔴 the confirmation screen is its OWN surface, not `manage`", async () => {
    // Same booking, very different moment. Folding them together would make
    // "how many people installed right after booking" - the number this whole
    // feature is judged by - unanswerable, because it would be mixed in with
    // everyone who opened a manage link days later.
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="confirmation" openPath="/book/manage/mt_abc" />);
    expect(await screen.findByText(/keep this appointment in your pocket/i)).toBeTruthy();
    expect(tracked).toHaveBeenCalledWith("app_banner_shown", { surface: "confirmation" });
  });

  it("each surface gets its own pitch", async () => {
    setUA(IPHONE_CHROME);
    const { unmount } = render(<GetTheApp surface="line" />);
    expect(await screen.findByText(/watch your place in line/i)).toBeTruthy();
    unmount();
    render(<GetTheApp surface="manage" />);
    expect(await screen.findByText(/manage bookings in the app/i)).toBeTruthy();
  });
});

describe("Open in ChairBack", () => {
  it("🔴 preserves the shop AND the prefill in the hand-off", async () => {
    // The whole point of openPath: landing in the app on a generic booking
    // screen instead of this shop, with this service, would make the app a
    // downgrade from the web page the customer was already looking at.
    setUA(IPHONE_SAFARI);
    render(
      <GetTheApp surface="booking" openPath="/book/cherncuts?service=svc_1&staff=stf_2" />,
    );
    const open = (await screen.findByText(/open in chairback/i)) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(
      "chairback://book/cherncuts?service=svc_1&staff=stf_2",
    );
  });

  it("🔴 is NOT an https universal link - iOS ignores those from the same domain", async () => {
    // An https://getchairback.com/book/... href here reloads the page the
    // customer is already on and nothing else, because iOS suppresses
    // universal links for same-domain navigations. That failure is silent,
    // which is exactly why it is pinned by a test.
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="manage" openPath="/book/manage/mt_abc" />);
    const open = (await screen.findByText(/open in chairback/i)) as HTMLAnchorElement;
    expect(open.getAttribute("href")).not.toMatch(/^https?:/);
  });

  it("without an openPath the card is install-only", async () => {
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="line" />);
    await screen.findByText(/get the app/i);
    expect(screen.queryByText(/open in chairback/i)).toBeNull();
  });
});

describe("analytics", () => {
  it("records the card being shown, and carries NO customer data", async () => {
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="booking" openPath="/book/cherncuts" />);
    await screen.findByText(/book faster next time/i);
    expect(tracked).toHaveBeenCalledWith("app_banner_shown", { surface: "booking" });
    // 🔴 The surface and nothing else. These fire on a page anyone can reach
    // by scanning a sticker on a wall: there is no identified customer to
    // attach, and attaching the shop would turn a counter into a record of
    // who visited which shop.
    for (const call of tracked.mock.calls) {
      expect(Object.keys(call[1] ?? {})).toEqual(["surface"]);
    }
  });

  it("records the App Store tap and the app-open tap separately", async () => {
    setUA(IPHONE_SAFARI);
    render(<GetTheApp surface="booking" openPath="/book/cherncuts" />);
    fireEvent.click(await screen.findByText(/open in chairback/i));
    fireEvent.click(screen.getByText(/get the app/i));
    expect(tracked).toHaveBeenCalledWith("app_opened", { surface: "booking" });
    expect(tracked).toHaveBeenCalledWith("app_store_clicked", { surface: "booking" });
  });

  it("stays silent where the card does not render", () => {
    setUA(ANDROID_CHROME);
    render(<GetTheApp surface="booking" />);
    expect(tracked).not.toHaveBeenCalled();
  });
});

describe("appleItunesApp", () => {
  it("emits the Smart App Banner meta content with the real listing id", () => {
    // 🔴 Must be importable from a SERVER module. It lived beside the client
    // component and calling it from a `metadata` export threw
    // "(0 , n.B) is not a function" at build time - compiled fine, failed only
    // in `next build`.
    expect(appleItunesApp()).toEqual({ "apple-itunes-app": "app-id=6783995804" });
  });
});
