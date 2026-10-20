import { describe, expect, it } from "vitest";
import { FRAME } from "./frameColors";

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
