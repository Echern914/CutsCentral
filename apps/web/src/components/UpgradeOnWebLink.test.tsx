import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const handoff = vi.hoisted(() => ({ code: "CODE.sig" as string | null, calls: 0 }));
vi.mock("@/lib/billingHandoffAction", () => ({
  startBillingHandoffAction: async () => {
    handoff.calls += 1;
    return handoff.code;
  },
}));

const { IfNativeBillingLink, NATIVE_BILLING_LABEL, UpgradeOnWebLink } = await import("./UpgradeOnWebLink");
const { billingBrowser, billingLinkMode, billingSafariPath } = await import("@/lib/useNativeBillingLink");

/**
 * "Since we can't upgrade plans on the phone, it should bring you to a link
 * that takes you to billing" (Eric, 2026-10-30) - and, once that link asked an
 * Apple-ID barber to sign in with something the website doesn't offer, it has
 * to arrive SIGNED IN (2026-11-01).
 *
 *  - web: an ordinary link to the plan cards;
 *  - in the app, every build: a button that fetches a one-time code and goes to
 *    /pricing?start=plan&h=<code> - the one page every build since July sends
 *    to Safari - never to billing itself, which an older build would load
 *    inside the WebView (buying inside the app is what 3.1.1 forbids).
 */

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

function inApp(capabilities: Record<string, unknown> | undefined) {
  const postMessage = vi.fn();
  w.ReactNativeWebView = { postMessage };
  if (capabilities) w.__cbNative = capabilities;
  return postMessage;
}

let go: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  handoff.code = "CODE.sig";
  handoff.calls = 0;
  go = vi.spyOn(billingBrowser, "go").mockImplementation(() => {});
});

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

describe("UpgradeOnWebLink in the app", () => {
  it.each([
    ["App Store 1.1.7 (54) - no openWeb", { openAuth: true, rewardsTab: true }],
    ["no capabilities at all", undefined],
    ["a newer build with openWeb", { openAuth: true, rewardsTab: true, openWeb: true }],
  ])("🔴 %s: the button opens Safari SIGNED IN, through /pricing, never billing in the WebView", async (_l, caps) => {
    const postMessage = inApp(caps);
    const { container } = render(<UpgradeOnWebLink wrapClassName="mt-2">Start your plan</UpgradeOnWebLink>);

    // No link the WebView could follow, anywhere, and no amount, ever.
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|\/mo/);
    const button = screen.getByRole("button", { name: new RegExp(NATIVE_BILLING_LABEL) });
    expect(button.textContent).toContain("getchairback.com");
    expect(container.querySelector("p.mt-2 button")).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(go).toHaveBeenCalledWith("/pricing?start=plan&h=CODE.sig");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("no code to be had: Safari still opens, and asks for a sign-in as before", async () => {
    inApp({ openAuth: true });
    handoff.code = null;
    render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(NATIVE_BILLING_LABEL) }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("/pricing?start=plan"));
  });

  it("a double tap opens Safari once", async () => {
    inApp({ openAuth: true });
    render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);
    const button = screen.getByRole("button", { name: new RegExp(NATIVE_BILLING_LABEL) });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(go).toHaveBeenCalledTimes(1);
    expect(handoff.calls).toBe(1);
  });
});

describe("billingSafariPath", () => {
  it("🔴 is /pricing - the page every app build sends to Safari - never billing or login", () => {
    for (const code of ["a.b", null]) {
      const path = billingSafariPath(code);
      // The shell's rule (AppWebView OPEN_EXTERNALLY_PATHS) matches the PATH
      // alone; /dashboard would be an in-app purchase, /login signs the app out.
      expect(path.replace(/[?#].*$/, "")).toBe("/pricing");
    }
  });

  it("carries the code, encoded", () => {
    expect(billingSafariPath("x+y/z.sig")).toBe("/pricing?start=plan&h=x%2By%2Fz.sig");
  });
});

describe("IfNativeBillingLink: its line only where the app button shows", () => {
  it("not on the web", () => {
    render(<IfNativeBillingLink>trial line</IfNativeBillingLink>);
    expect(screen.queryByText("trial line")).toBeNull();
  });

  it("in any app build", () => {
    inApp({ openAuth: true, rewardsTab: true });
    render(<IfNativeBillingLink>trial line</IfNativeBillingLink>);
    expect(screen.getByText("trial line")).toBeTruthy();
  });
});

describe("billingLinkMode", () => {
  const bridge = { postMessage: () => {} };
  it("decides from the bridge and the kill switch; every build gets the button", () => {
    expect(billingLinkMode({}, true)).toBe("web");
    expect(billingLinkMode({}, false)).toBe("web");
    expect(billingLinkMode({ ReactNativeWebView: bridge }, true)).toBe("native");
    // The kill switch still takes it out of every build.
    expect(billingLinkMode({ ReactNativeWebView: bridge }, false)).toBe("none");
  });
});
