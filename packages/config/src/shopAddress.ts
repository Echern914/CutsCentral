/**
 * Where the shop is — formatted in exactly ONE place.
 *
 * 🔴 WHY THIS IS SHARED CODE. The address is a fact a customer acts on: they
 * drive to it. It is already rendered by the SMS receptionist, written into
 * the .ics calendar attachment, and shown on the public page — and until this
 * file existed each of those spelled it out for itself, with its own idea of
 * when a partial address was good enough to publish. That is the same shape as
 * the cancellation fee before `cancellationFeeCents`: two copies of a
 * customer-facing fact, drifting on their own schedules, and the customer
 * hears whichever one happens to answer.
 *
 * THE FLOOR IS STREET + CITY. A street with no city, or a city with no street,
 * is not something anyone can navigate to — publishing it would be worse than
 * saying nothing, because it looks like an answer. Region and postal join in
 * when present and are never required.
 */

export interface ShopAddressInput {
  addressStreet?: string | null;
  addressCity?: string | null;
  addressRegion?: string | null;
  addressPostal?: string | null;
}

const clean = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * True when the shop has published an address a customer could actually use.
 * Every surface asks THIS rather than testing columns for itself.
 */
export function hasShopAddress(shop: ShopAddressInput): boolean {
  return clean(shop.addressStreet).length > 0 && clean(shop.addressCity).length > 0;
}

/**
 * The address as display lines: `["123 Main St", "Brooklyn, NY 11201"]`.
 * Empty when there is no usable address, so a caller can spread it without a
 * conditional and never render an empty "Where" block.
 */
export function shopAddressLines(shop: ShopAddressInput): string[] {
  if (!hasShopAddress(shop)) return [];
  const regionPostal = [clean(shop.addressRegion), clean(shop.addressPostal)]
    .filter(Boolean)
    .join(" ");
  const second = [clean(shop.addressCity), regionPostal].filter(Boolean).join(", ");
  return [clean(shop.addressStreet), second].filter(Boolean);
}

/**
 * One line: `"123 Main St, Brooklyn, NY 11201"`. Null when the shop has not
 * published one — callers decide what to say instead, and none of them may
 * guess.
 */
export function formatShopAddress(shop: ShopAddressInput): string | null {
  const lines = shopAddressLines(shop);
  return lines.length > 0 ? lines.join(", ") : null;
}

/**
 * A tappable directions link, or null.
 *
 * Google's documented `search/?api=1` form on purpose: it is the one URL that
 * behaves everywhere. iOS opens Google Maps when installed and the web map
 * when not, Android hands it to the maps app, and a desktop browser just shows
 * the map. A `geo:` or `maps://` scheme would be shorter and would dead-end on
 * half the devices that receive our emails.
 */
export function mapsUrlFor(shop: ShopAddressInput): string | null {
  const address = formatShopAddress(shop);
  if (address === null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}
