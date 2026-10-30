import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IfNativeBillingLink, NATIVE_BILLING_LABEL, UpgradeOnWebLink } from "./UpgradeOnWebLink";
import { billingLinkMode, OPEN_WEB_MESSAGE } from "@/lib/useNativeBillingLink";

/**
 * "Since we can't upgrade plans on the phone, it should bring you to a link
 * that takes you to billing" (Eric, 2026-10-30).
 *
 *  - web: an ordinary link to the plan cards;
 *  - an app build that can open Safari: a button that ASKS THE APP to open
 *    billing there, and never navigates the WebView itself (buying inside the
 *    WebView is exactly what 3.1.1 forbids);
 *  - an older app build: nothing - it would load any billing link inside the
 *    WebView.
 */

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

function inApp(capabilities: Record<string, unknown> | undefined) {
  const postMessage = vi.fn();
  w.ReactNativeWebView = { postMessage };
  if (capabilities) w.__cbNative = capabilities;
  return postMessage;
}

afterEach(() => {
  cleanup();
  delete w.ReactNativeWebView;
  delete w.__cbNative;
  vi.restoreAllMocks();
});

describe("UpgradeOnWebLink on the web", () => {
  it("is a normal link to the plan cards on the billing page, in the call site's words", () => {
    render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);
    const link = screen.getByRole("link", { name: "Start your plan" });
    expect(link.getAttribute("href")).toBe("/dashboard/billing#plans");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is wrapped so the app hides it from the first paint, before hydration says where it is", () => {
    const { container } = render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);
    expect(container.querySelector("[data-native-hide] a")).not.toBeNull();
  });
});

describe("UpgradeOnWebLink in an app build that can open Safari", () => {
  it("🔴 asks the app to open billing in the browser, and never navigates the WebView", () => {
    const postMessage = inApp({ openAuth: true, rewardsTab: true, openWeb: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = window.location.href;
    const { container } = render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);

    // No link the WebView could follow, anywhere.
    expect(container.querySelector("a")).toBeNull();
    const button = screen.getByRole("button", { name: new RegExp(NATIVE_BILLING_LABEL) });
    expect(button.textContent).toContain("getchairback.com");
    // No amount in the app, ever.
    expect(container.textContent).not.toMatch(/\$|\/mo/);

    fireEvent.click(button);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: OPEN_WEB_MESSAGE,
      path: "/dashboard/billing#plans",
    });
    // The page stayed put: jsdom reports any attempted navigation on the
    // console ("Not implemented: navigation").
    expect(window.location.href).toBe(before);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/navigation/i);
  });

  it("puts the result in the call site's paragraph", () => {
    inApp({ openWeb: true });
    const { container } = render(<UpgradeOnWebLink wrapClassName="mt-2">Upgrade</UpgradeOnWebLink>);
    expect(container.querySelector("p.mt-2 button")).not.toBeNull();
  });
});

describe("UpgradeOnWebLink in an OLDER app build", () => {
  it.each([
    ["no capabilities at all", undefined],
    ["today's App Store build (openAuth + rewardsTab, no openWeb)", { openAuth: true, rewardsTab: true }],
  ])("%s: shows nothing - no link, no button, no empty paragraph", (_label, caps) => {
    const postMessage = inApp(caps);
    const { container } = render(<UpgradeOnWebLink wrapClassName="mt-2">Start your plan</UpgradeOnWebLink>);
    expect(container.innerHTML).toBe("");
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("IfNativeBillingLink: its line only where the app button shows", () => {
  it("not on the web", () => {
    render(<IfNativeBillingLink>trial line</IfNativeBillingLink>);
    expect(screen.queryByText("trial line")).toBeNull();
  });

  it("not in an older build", () => {
    inApp({ openAuth: true, rewardsTab: true });
    render(<IfNativeBillingLink>trial line</IfNativeBillingLink>);
    expect(screen.queryByText("trial line")).toBeNull();
  });

  it("in a build that can open Safari", () => {
    inApp({ openWeb: true });
    render(<IfNativeBillingLink>trial line</IfNativeBillingLink>);
    expect(screen.getByText("trial line")).toBeTruthy();
  });
});

describe("billingLinkMode", () => {
  const bridge = { postMessage: () => {} };
  it("decides from the bridge, the capability and the kill switch", () => {
    expect(billingLinkMode({}, true)).toBe("web");
    expect(billingLinkMode({}, false)).toBe("web");
    expect(billingLinkMode({ ReactNativeWebView: bridge, __cbNative: { openWeb: true } }, true)).toBe("native");
    expect(billingLinkMode({ ReactNativeWebView: bridge, __cbNative: { openWeb: true } }, false)).toBe("none");
    expect(billingLinkMode({ ReactNativeWebView: bridge, __cbNative: {} }, true)).toBe("none");
    expect(billingLinkMode({ ReactNativeWebView: bridge }, true)).toBe("none");
    // A bridge without postMessage could not deliver the request.
    expect(billingLinkMode({ ReactNativeWebView: {}, __cbNative: { openWeb: true } }, true)).toBe("none");
  });
});
