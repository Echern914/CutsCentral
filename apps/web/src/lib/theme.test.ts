import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_SCHEME_ATTR,
  PAGE_DARK_PREPAINT_SCRIPT,
  PAGE_SCHEME_ATTR,
  PREPAINT_SCRIPT,
  applyTheme,
  storedTheme,
  suspendTheme,
  themeableRoute,
  wearPageDark,
} from "./theme";

/**
 * Light is ChairBack's main look (Eric, 2026-10-17); dark is a barber's own
 * choice for their dashboard. No attribute = light, so every page renders
 * light from its first paint.
 */
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("appearance", () => {
  it("🔴 with no choice made, it's light - no attribute at all", () => {
    expect(storedTheme()).toBe("light");
    applyTheme(storedTheme());
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("a barber who picks dark gets dark, remembered for the next visit", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storedTheme()).toBe("dark");
  });

  it("🔴 the pre-paint script applies a stored dark before first paint, and nothing otherwise", () => {
    new Function(PREPAINT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    localStorage.setItem("cb-theme", "dark");
    new Function(PREPAINT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("every page outside the dashboard is light, without forgetting their choice", () => {
    applyTheme("dark");
    expect(themeableRoute("/book/drick")).toBe(false);
    expect(themeableRoute("/")).toBe(false);
    suspendTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(storedTheme()).toBe("dark");
    expect(themeableRoute("/dashboard/booking")).toBe(true);
  });
});

describe("a booking page wearing its shop's dark page (Drick: \"switch it to black\")", () => {
  const mark = (scheme: "light" | "dark") => {
    const el = document.createElement("span");
    el.setAttribute(PAGE_SCHEME_ATTR, scheme);
    document.body.appendChild(el);
    return el;
  };

  it("🔴 stays dark on a public route while the page says so - and is never remembered", () => {
    const el = mark("dark");
    try {
      new Function(PAGE_DARK_PREPAINT_SCRIPT)();
      suspendTheme(); // what ThemeScope does on every public route
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(storedTheme()).toBe("light"); // the shop's look, not anyone's choice
    } finally {
      el.remove();
    }
  });

  it("leaving that page drops the dark", () => {
    wearPageDark();
    suspendTheme(); // no marker any more
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("a light shop page is ChairBack's light", () => {
    const el = mark("light");
    try {
      suspendTheme();
      expect(document.documentElement.dataset.theme).toBeUndefined();
    } finally {
      el.remove();
    }
  });
});

describe("🔴 the app's bar above a page matches the page (Eric: \"white slab on top\")", () => {
  const bridge = () => {
    const sent: string[] = [];
    (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: (m: string) => sent.push(m) };
    return sent;
  };
  const unbridge = () => delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;

  it("a dark booking page tells the app BEFORE it paints, so the bar never flashes cream", () => {
    const sent = bridge();
    try {
      new Function(PAGE_DARK_PREPAINT_SCRIPT)();
      expect(sent).toEqual(["cb:theme:dark"]);
    } finally {
      unbridge();
    }
  });

  it("a storefront in its own dark colours tells the app dark - and changes nothing on the page", () => {
    const sent = bridge();
    const el = document.createElement("span");
    el.setAttribute(APP_SCHEME_ATTR, "dark");
    document.body.appendChild(el);
    try {
      suspendTheme(); // what ThemeScope does on every public route
      expect(sent).toEqual(["cb:theme:dark"]);
      expect(document.documentElement.dataset.theme).toBeUndefined();
    } finally {
      el.remove();
      unbridge();
    }
  });

  it("no marker: the app hears light, as before", () => {
    const sent = bridge();
    try {
      suspendTheme();
      expect(sent).toEqual(["cb:theme:light"]);
    } finally {
      unbridge();
    }
  });
});

describe("inside the iPhone app", () => {
  it("🔴 tells the app which theme is showing, so the status bar matches", () => {
    const sent: string[] = [];
    (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: (m: string) => sent.push(m) };
    try {
      applyTheme("dark");
      suspendTheme();
      applyTheme("light");
      expect(sent).toEqual(["cb:theme:dark", "cb:theme:light", "cb:theme:light"]);
    } finally {
      delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
    }
  });
});
