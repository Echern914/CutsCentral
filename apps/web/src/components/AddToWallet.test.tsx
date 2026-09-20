import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddToWallet } from "./AddToWallet";

/**
 * THE BADGE THAT MUST NOT APPEAR.
 *
 * Every rule here is a way for "Add to Apple Wallet" to be a lie. A badge shown
 * where the pass cannot be minted downloads a 503; one shown on Android does
 * nothing at all when tapped, because Wallet is an Apple feature.
 *
 * INSIDE THE APP the badge is now a BUTTON that asks the shell to present
 * PassKit, because a WKWebView cannot complete a navigation to a .pkpass. It
 * needs a manage token to do that, so the punch card - which has none - still
 * renders nothing in the app, exactly as before.
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

  it("🔴 never renders a LINK inside the native app WebView", () => {
    // WKWebView cannot complete a navigation to a .pkpass, so a link there is
    // a tap that silently does nothing. This assertion is the reason the
    // component switches element rather than just switching handler.
    setAgent(IOS);
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: () => {},
    };
    render(<AddToWallet {...APPT} available manageToken="tok123" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: APPT.label })).toBeTruthy();
  });

  it("🔴 the punch card stays hidden in the app - it has no native path", () => {
    // Only the appointment pass has a manage token, and the bridge is built
    // around one. No token means no in-app route to PassKit, and silence is
    // the honest outcome rather than a button that cannot work.
    setAgent(IOS);
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: () => {},
    };
    const { container } = render(
      <AddToWallet
        href="/r/magic999/wallet-pass"
        available
        label="Add your punch card to Apple Wallet"
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("asks the shell for the pass, naming THIS appointment", () => {
    setAgent(IOS);
    const posted: string[] = [];
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: (m: string) => posted.push(m),
    };
    render(<AddToWallet {...APPT} available manageToken="tok123" />);
    fireEvent.click(screen.getByRole("button", { name: APPT.label }));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toEqual({
      type: "cb:add-wallet-pass",
      manageToken: "tok123",
    });
  });

  it("🔴 stays hidden in the app when the pass cannot be minted", () => {
    // The env gate applies to the native path exactly as it does to Safari: a
    // button that opens PassKit onto a 404 is worse than no button.
    setAgent(IOS);
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: () => {},
    };
    const { container } = render(
      <AddToWallet {...APPT} available={false} manageToken="tok123" />,
    );
    expect(container.textContent).toBe("");
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
