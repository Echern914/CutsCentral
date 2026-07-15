/**
 * WCAG contrast helpers for shop-configurable accent colors. Shops pick an
 * arbitrary hex accent; anywhere we paint text ON that accent we must choose a
 * foreground that actually reads (a fixed "#101012" fails on dark accents).
 */

/** Relative luminance (WCAG 2.x definition) of a #RRGGBB hex color. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const int = parseInt(m[1]!, 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21) between two #RRGGBB hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The readable foreground (near-black or white) for text sitting on `bg`.
 * Picks whichever of the two site foregrounds has the higher contrast ratio.
 */
export function readableOn(bg: string): string {
  const dark = "#101012"; // site near-black
  const light = "#FFFFFF";
  return contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light;
}
