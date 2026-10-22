import { describe, expect, it } from "vitest";
import { FRAME, PAGE_BAR } from "./frameColors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// WCAG relative luminance / contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the app frame around the dashboard is never white on white", () => {
  it("the spinner, title and message read against the cream", () => {
    // 3:1 is the floor for a spinner (a graphic); text gets 4.5:1.
    expect(contrast(FRAME.spinner, FRAME.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(FRAME.title, FRAME.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(FRAME.sub, FRAME.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the Retry button stands out from the cream and its label reads on it", () => {
    expect(contrast(FRAME.buttonBg, FRAME.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(FRAME.buttonText, FRAME.buttonBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the 1.1.6 colours (white spinner and title on cream) would fail", () => {
    expect(contrast("#FFFFFF", FRAME.bg)).toBeLessThan(3);
  });
});

describe("the bar above a shop's page wears the page's scheme", () => {
  it("🔴 both schemes read: title and Done against their own bar", () => {
    for (const scheme of ["light", "dark"] as const) {
      const bar = PAGE_BAR[scheme];
      expect(contrast(bar.title, bar.bg)).toBeGreaterThanOrEqual(4.5);
      // "Done" is a bold headline: large-text floor.
      expect(contrast(bar.tint, bar.bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("the light bar is the app's own cream, unchanged", () => {
    // Read as text: customer/theme.ts imports react-native, which this
    // node-only runner cannot load.
    const here = dirname(fileURLToPath(import.meta.url));
    const theme = readFileSync(join(here, "customer", "theme.ts"), "utf8");
    const token = (name: string) => new RegExp(`\\b${name}: "(#[0-9A-Fa-f]{6})"`).exec(theme)?.[1];
    expect(PAGE_BAR.light.bg).toBe(token("bg"));
    expect(PAGE_BAR.light.title).toBe(token("text"));
    expect(PAGE_BAR.light.tint).toBe(token("goldText"));
  });

  it("the old look - a cream bar over a black page - is the contrast it replaces", () => {
    // The white status-bar clock a dark page asks for, on the cream bar.
    expect(contrast("#FFFFFF", PAGE_BAR.light.bg)).toBeLessThan(1.2);
    expect(contrast("#FFFFFF", PAGE_BAR.dark.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
