import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * "Plan & billing" in the More sheet and the Ctrl-K palette, inside the app.
 *
 *  - any app build, kill switch on: the entry is there as "Plan & billing ↗",
 *    and choosing it opens billing in Safari, signed in, through /pricing
 *    (lib/useNativeBillingLink.ts) - never billing in the WebView (no <a>, no
 *    router.push), because buying inside the WebView is what 3.1.1 forbids;
 *  - the kill switch off: the entry is not there at all.
 *
 * No useIsNativeApp mock here on purpose: the real hooks read the same
 * window.ReactNativeWebView / __cbNative the app injects.
 */
const push = vi.hoisted(() => vi.fn());
const killSwitch = vi.hoisted(() => ({ on: true }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/dashboard/insights",
}));
vi.mock("@chairback/config/features", async (importOriginal) => {
  const real = await importOriginal<typeof import("@chairback/config/features")>();
  return {
    ...real,
    get NATIVE_EXTERNAL_BILLING_LINK() {
      return killSwitch.on;
    },
  };
});

vi.mock("@/lib/billingHandoffAction", () => ({ startBillingHandoffAction: async () => "CODE.sig" }));

const { MoreSheet } = await import("./MoreSheet");
const { FeatureSearch } = await import("./FeatureSearch");
const { billingBrowser } = await import("@/lib/useNativeBillingLink");

/** Safari, signed in (lib/useNativeBillingLink.ts billingSafariPath). */
const SIGNED_IN = "/pricing?start=plan&h=CODE.sig";

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

function app(capabilities: Record<string, unknown>) {
  const postMessage = vi.fn();
  w.ReactNativeWebView = { postMessage };
  w.__cbNative = capabilities;
  return postMessage;
}
const CAPABLE = { openAuth: true, rewardsTab: true, openWeb: true };
const TODAYS_BUILD = { openAuth: true, rewardsTab: true };

let go: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  push.mockReset();
  localStorage.clear();
  killSwitch.on = true;
  go = vi.spyOn(billingBrowser, "go").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  delete w.ReactNativeWebView;
  delete w.__cbNative;
  vi.restoreAllMocks();
});

function moreSheet(onClose = vi.fn()) {
  const r = render(<MoreSheet open onClose={onClose} role="OWNER" rewardsEnabled affiliateProgramEnabled />);
  return { ...r, onClose };
}

function palette(query: string) {
  render(<FeatureSearch role="OWNER" rewardsEnabled affiliateProgramEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Search features (Ctrl+K)" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Search features" }), { target: { value: query } });
}

const billingAnchors = () => document.querySelectorAll('a[href^="/dashboard/billing"]');

describe("the More sheet in the app", () => {
  it.each([
    ["the build on phones today", TODAYS_BUILD],
    ["a newer build with openWeb", CAPABLE],
  ])("🔴 %s: Plan & billing ↗ opens billing in Safari, signed in, through /pricing", async (_l, caps) => {
    const postMessage = app(caps);
    const { onClose } = moreSheet();

    const row = screen.getByRole("button", { name: /Plan & billing.*opens your browser/ });
    expect(row.textContent).toContain("↗");
    expect(billingAnchors()).toHaveLength(0);

    fireEvent.click(row);
    await waitFor(() => expect(go).toHaveBeenCalledWith(SIGNED_IN));
    expect(postMessage).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the More sheet, unchanged", () => {
  it.each([
    ["the kill switch off (newer build)", () => {
      killSwitch.on = false;
      app(CAPABLE);
    }],
    ["the kill switch off (older build)", () => {
      killSwitch.on = false;
      app(TODAYS_BUILD);
    }],
  ])("%s: no Plan & billing at all, and no billing link", (_label, setup) => {
    setup();
    moreSheet();
    expect(screen.queryByText(/Plan & billing/)).toBeNull();
    expect(billingAnchors()).toHaveLength(0);
  });

  it("on the web it is the ordinary link", () => {
    moreSheet();
    expect(screen.getByRole("link", { name: /Plan & billing/ }).getAttribute("href")).toBe("/dashboard/billing");
  });
});

describe("the palette in an app build that can open Safari", () => {
  it("🔴 choosing Plan & billing ↗ opens Safari signed in and never router.pushes", async () => {
    app(CAPABLE);
    palette("billing");
    const row = screen.getAllByRole("option").find((o) => within(o).queryByText(/Plan & billing/));
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("↗");
    fireEvent.click(within(row!).getAllByRole("button")[0]!);
    await waitFor(() => expect(go).toHaveBeenCalledWith(SIGNED_IN));
    expect(push).not.toHaveBeenCalled();
  });

  it("Enter on it does the same", async () => {
    app(CAPABLE);
    palette("plan & billing");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search features" }), { key: "Enter" });
    await waitFor(() => expect(go).toHaveBeenCalledWith(SIGNED_IN));
    expect(push).not.toHaveBeenCalled();
  });

  it("every other feature still navigates in the app as before", () => {
    app(CAPABLE);
    palette("tips");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search features" }), { key: "Enter" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![0]).not.toMatch(/billing/);
  });
});

describe("the palette in an OLDER build", () => {
  it("offers Plan & billing ↗, opens Safari signed in, and never router.pushes to it", async () => {
    const postMessage = app(TODAYS_BUILD);
    palette("billing");
    const row = screen.getAllByRole("option").find((o) => within(o).queryByText(/Plan & billing/));
    expect(row!.textContent).toContain("↗");
    fireEvent.click(within(row!).getAllByRole("button")[0]!);
    await waitFor(() => expect(go).toHaveBeenCalledWith(SIGNED_IN));
    expect(postMessage).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("the palette, unchanged", () => {
  it.each([
    ["the kill switch off (newer build)", () => {
      killSwitch.on = false;
      app(CAPABLE);
    }],
    ["the kill switch off (older build)", () => {
      killSwitch.on = false;
      app(TODAYS_BUILD);
    }],
  ])("%s: billing is not offered", (_label, setup) => {
    setup();
    palette("billing");
    for (const o of screen.queryAllByRole("option")) {
      expect(within(o).queryByText(/Plan & billing/)).toBeNull();
    }
  });
});
