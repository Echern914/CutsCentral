import { PAGE_THEMES, type PageThemeKey } from "@chairback/config/constants";

/**
 * Which look the booking page wears: the shop's own page scheme.
 *
 * 🔴 THE BOOKING PAGE IS PART OF THE SHOP'S PAGE. When white & gold became
 * ChairBack's main look (2026-10-17) the shop pages kept their own colours, but
 * the booking page went with the platform - so a shop with a black page sent
 * its clients from black into white mid-booking (Drick, 2026-10-22). It now
 * follows the page it is booked from.
 *
 * - The shop's page theme, by the same fallback the shop page uses (an unknown
 *   or missing key is Classic Gold, which is dark).
 * - No page data at all (the read failed, or the shop has no public page):
 *   ChairBack's own light look - nothing to match, so nothing to guess.
 */
export function bookingScheme(page: { theme?: string | null } | null): "light" | "dark" {
  if (!page) return "light";
  const key = (page.theme ?? "classic") as PageThemeKey;
  const theme = PAGE_THEMES[key in PAGE_THEMES ? key : "classic"];
  return theme.scheme;
}
