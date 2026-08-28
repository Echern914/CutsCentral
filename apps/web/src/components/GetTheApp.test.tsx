import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GetTheApp } from "./GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";

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

  it("says nothing in iOS SAFARI - Apple's own banner is already there", () => {
    setUA(IPHONE_SAFARI);
    const { container } = render(<GetTheApp surface="booking" />);
    expect(container.textContent).toBe("");
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

  it("each surface gets its own pitch", async () => {
    setUA(IPHONE_CHROME);
    const { unmount } = render(<GetTheApp surface="line" />);
    expect(await screen.findByText(/watch your place in line/i)).toBeTruthy();
    unmount();
    render(<GetTheApp surface="manage" />);
    expect(await screen.findByText(/manage bookings in the app/i)).toBeTruthy();
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
