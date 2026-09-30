/**
 * THE KEY TO A CLIENT'S SAVED CARD, ON THIS DEVICE.
 *
 * When a client saves their card at a shop, the browser they saved it on is
 * handed a key (and any other phone gets one after a text code). With it, the
 * booking page offers "Pay with Visa •••• 4242" and the booking goes straight
 * through - no card step. The key is all the server needs to see: it is the
 * proof of possession that stands in for typing the card again, so it lives
 * only here, per shop. The card number never touches this page; only the brand
 * and last four, for the button.
 *
 * Forgotten when the server says it no longer works (the client removed the
 * card, or it belongs to someone else), and on "Not you?". Every storage call
 * is guarded: blocked storage just means the card step, as before.
 */

export interface DeviceSavedCard {
  token: string;
  brand: string | null;
  last4: string | null;
}

export const SAVED_CARD_KEY = "chairback:savedcard:v1";
const MAX_SHOPS = 10;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(store: Store): Record<string, DeviceSavedCard> {
  let raw: string | null;
  try {
    raw = store.getItem(SAVED_CARD_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const kept: Record<string, DeviceSavedCard> = {};
  for (const [shop, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { token, brand, last4 } = v as Record<string, unknown>;
    if (typeof token !== "string" || token.length < 20 || token.length > 200) continue;
    kept[shop] = {
      token,
      brand: typeof brand === "string" && brand.length <= 30 ? brand : null,
      last4: typeof last4 === "string" && /^\d{4}$/.test(last4) ? last4 : null,
    };
  }
  return kept;
}

function writeAll(store: Store, all: Record<string, DeviceSavedCard>): void {
  try {
    if (Object.keys(all).length === 0) store.removeItem(SAVED_CARD_KEY);
    else store.setItem(SAVED_CARD_KEY, JSON.stringify(all));
  } catch {
    // The card is still saved at the shop; this device just won't offer it.
  }
}

/** This device's key to its saved card at this shop, or null. */
export function readDeviceSavedCard(shop: string, store: Store | null = defaultStore()): DeviceSavedCard | null {
  return store ? (readAll(store)[shop] ?? null) : null;
}

export function rememberDeviceSavedCard(
  shop: string,
  card: DeviceSavedCard,
  store: Store | null = defaultStore(),
): void {
  if (!store) return;
  const all = readAll(store);
  delete all[shop];
  // Newest last; the oldest shops drop off past the cap.
  const entries = [...Object.entries(all), [shop, card] as const].slice(-MAX_SHOPS);
  writeAll(store, Object.fromEntries(entries));
}

export function forgetDeviceSavedCard(shop: string, store: Store | null = defaultStore()): void {
  if (!store) return;
  const all = readAll(store);
  if (!(shop in all)) return;
  delete all[shop];
  writeAll(store, all);
}

/** "Visa •••• 4242" - or a plain fallback when Stripe gave no brand. */
export function savedCardLabel(card: { brand: string | null; last4: string | null }): string {
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card";
  return card.last4 ? `${brand} •••• ${card.last4}` : `${brand} on file`;
}
