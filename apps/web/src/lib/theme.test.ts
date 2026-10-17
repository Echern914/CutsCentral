import { beforeEach, describe, expect, it } from "vitest";
import { PREPAINT_SCRIPT, applyTheme, storedTheme, suspendTheme, themeableRoute } from "./theme";

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
