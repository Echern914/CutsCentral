import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AddToWallet } from "./AddToWallet";

/**
 * THE BADGE THAT MUST NOT APPEAR.
 *
 * Every rule here is a way for "Add to Apple Wallet" to be a lie. A badge shown
 * where the pass cannot be minted downloads a 503; one shown on Android or in
 * the native WebView does nothing at all when tapped, because Wallet is an
 * Apple feature and WKWebView cannot present the Add-Pass sheet from a plain
 * navigation. All three gates have to hold together, so each is pinned here.
 *
 * 🔴 The appointment pass is DARK in production today (WALLET_APPT_* unset), so
 * `available: false` is the LIVE case, not the edge case.
 */
const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function setAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  setAgent(MAC);
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  vi.unstubAllGlobals();
});

const APPT = {
  href: "/book/manage/tok123/wallet-pass",
  label: "Add this appointment to Apple Wallet",
};

describe("AddToWallet", () => {
  it("shows on iOS Safari once the pass can actually be minted", () => {
    setAgent(IOS);
    render(<AddToWallet {...APPT} available />);
    const link = screen.getByRole("link", { name: APPT.label });
    expect(link).toHaveAttribute("href", "/book/manage/tok123/wallet-pass");
  });

  it("STAYS HIDDEN while the pass type is unconfigured", () => {
    // The live state for the appointment pass until the Apple certs are set.
    setAgent(IOS);
    render(<AddToWallet {...APPT} available={false} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("stays hidden off iOS, where Wallet does not exist", () => {
    setAgent(ANDROID);
    render(<AddToWallet {...APPT} available />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("stays hidden inside the native app WebView", () => {
    // 🔴 WKWebView cannot present the Add-Pass sheet from a navigation, so the
    // badge would be a button that silently does nothing.
    setAgent(IOS);
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {};
    render(<AddToWallet {...APPT} available />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing at all on the server pass (no badge before hydration)", () => {
    // Starts hidden and reveals in an effect, so SSR never emits a badge the
    // client would then remove — that mismatch is a hydration error.
    setAgent(MAC);
    const { container } = render(<AddToWallet {...APPT} available />);
    expect(container.textContent).toBe("");
  });

  it("carries the caller's own href and label, so two passes never collide", () => {
    setAgent(IOS);
    render(
      <AddToWallet
        href="/r/magic999/wallet-pass"
        available
        label="Add your punch card to Apple Wallet"
      />,
    );
    const link = screen.getByRole("link", {
      name: "Add your punch card to Apple Wallet",
    });
    expect(link).toHaveAttribute("href", "/r/magic999/wallet-pass");
    // Apple's badge wording is fixed; only the accessible name distinguishes
    // the two passes for a screen reader.
    expect(link).toHaveTextContent(/Add to\s*Apple Wallet/);
  });
});
