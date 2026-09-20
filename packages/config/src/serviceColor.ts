import { SERVICE_COLORS, SERVICE_COLOR_KEYS, type ServiceColorKey } from "./constants.js";

/**
 * THE ONE PLACE A SERVICE'S CALENDAR COLOUR IS DECIDED.
 *
 * 🔴 WHY A FALLBACK EXISTS AT ALL. `Service.color` is nullable and defaults to
 * null, and an Acuity-synced booking arrives as a `Visit` carrying a free-text
 * service name and no service row whatsoever. Measured on drickcuttinup for the
 * next 30 days: 81 appointments, of which 70 are synced Visits and 7 more are
 * native rows whose service has no colour - so 77 of 81 cards, 95%, render with
 * no colour at all today. A palette nobody has filled in is not colour-coding.
 *
 * So an unset colour resolves to a DETERMINISTIC one derived from the service
 * name. The same name yields the same colour on every surface, every render and
 * every device, because it is a pure function of the name - not a counter, not
 * a random pick, not an index into whatever order the query returned.
 *
 * 🔴 THE FALLBACK IS NOT ACUITY'S COLOUR. Acuity's API does expose an
 * appointment-type colour, but ChairBack does not ingest it and this module
 * does not pretend to: a derived colour is ChairBack's own, chosen so the
 * barber can tell two services apart at a glance. Nothing here should ever be
 * described to a barber as "your Acuity colour".
 *
 * 🔴 COLOUR IS NEVER THE ONLY CUE. Every surface that uses this also renders
 * the service NAME. Colour distinguishes at a glance for someone who already
 * knows their own services; it cannot identify anything on its own, and about
 * one man in twelve cannot reliably tell several of these palette entries
 * apart.
 */

/**
 * The comparison key for a service name.
 *
 * Lowercased, punctuation dropped, whitespace collapsed - so "Haircut + Beard",
 * "haircut & beard" and "Haircut  and  Beard" are one service for both the
 * Acuity match and the fallback. Deliberately does NOT stem or strip words: a
 * "Kids Haircut" must not collapse into "Haircut", because those are two
 * services a barber prices and schedules differently.
 */
export function normalizeServiceName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    // "&" and "+" both read as "and" when a barber types the same service twice.
    .replace(/[&+]/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A stable 32-bit hash (FNV-1a) of the normalised name.
 *
 * FNV rather than summing char codes: a sum gives "Fade" and "Deaf" the same
 * value, and anagram collisions across a barber's own service list are exactly
 * the case that would hand two different services one colour.
 */
function hashName(normalized: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    // 16777619, via shifts, to stay in 32-bit integer maths.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The deterministic palette entry for a service name. Same name, same colour. */
export function fallbackServiceColorKey(serviceName: string): ServiceColorKey {
  const normalized = normalizeServiceName(serviceName);
  const idx = hashName(normalized) % SERVICE_COLOR_KEYS.length;
  return SERVICE_COLOR_KEYS[idx]!;
}

export interface ResolvedServiceColor {
  /** The palette key, or null when there is no name and no explicit choice. */
  key: ServiceColorKey | null;
  /** The hex to paint, or null. */
  hex: string | null;
  /** True when this came from the name rather than the barber's own choice. */
  derived: boolean;
}

const EMPTY: ResolvedServiceColor = { key: null, hex: null, derived: false };

/**
 * Resolve the colour for one calendar row.
 *
 * Order, and it matters:
 *   1. the barber's EXPLICIT choice on the Service, if it is a key we know;
 *   2. otherwise a deterministic colour from the service name;
 *   3. otherwise nothing - a row with no service name (a block, an unavailable
 *      band) gets no service colour, because it has no service.
 *
 * An unrecognised explicit key falls through to the name rather than painting
 * nothing: the palette can be re-tuned without stranding rows that stored an
 * older key.
 */
export function resolveServiceColor(input: {
  explicitKey?: string | null;
  serviceName?: string | null;
}): ResolvedServiceColor {
  const explicit = input.explicitKey ?? null;
  if (explicit && explicit in SERVICE_COLORS) {
    const key = explicit as ServiceColorKey;
    return { key, hex: SERVICE_COLORS[key].hex, derived: false };
  }
  const name = input.serviceName?.trim();
  if (!name) return EMPTY;
  const key = fallbackServiceColorKey(name);
  return { key, hex: SERVICE_COLORS[key].hex, derived: true };
}

/**
 * Relative luminance (WCAG 2.1), used to pick a readable foreground.
 */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, or null if either is unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A readable foreground for text sitting ON a palette colour.
 *
 * 🔴 ONLY FOR A SOLID FILL. The calendar paints these as a left edge and a dot
 * beside text that sits on the card's own background, which is the whole reason
 * a saturated palette is safe there. This exists for the places that DO fill -
 * a status chip, a legend swatch - so nobody hand-picks white on amber.
 */
export function readableForeground(
  backgroundHex: string,
  options: { dark?: string; light?: string } = {},
): string {
  const dark = options.dark ?? "#0A0A0B";
  const light = options.light ?? "#FFFFFF";
  const withDark = contrastRatio(backgroundHex, dark);
  const withLight = contrastRatio(backgroundHex, light);
  if (withDark === null || withLight === null) return light;
  return withDark >= withLight ? dark : light;
}
