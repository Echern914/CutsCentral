import { apiEnv, normalizeShopHandle, shopHandleKey } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";

/**
 * ONE shop, found by its exact handle.
 *
 * This is the lookup behind "Find a shop" AND behind "Add to my shops". It is
 * one function on purpose: saving a shop must never be able to discover a shop
 * that finding one could not. Why it is an exact lookup and never a search is
 * written down on routes/findShop.public.ts.
 */

export const PUBLIC_SHOP_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  addressCity: true,
  addressRegion: true,
  publicPageEnabled: true,
  bookingMode: true,
  bookingUrl: true,
} as const;

interface PublicShopRow {
  id: string;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  publicPageEnabled: boolean;
  bookingMode: string;
  bookingUrl: string | null;
}

export interface PublicShop {
  /** Internal. The public finder never sends it; it is what a save stores. */
  id: string;
  name: string;
  handle: string;
  logoUrl: string | null;
  /** The town, so the right shop can be confirmed. Never the street address. */
  town: string | null;
  pageUrl: string;
  /** Where to book: here for a native shop, else its own link or its page. */
  bookUrl: string;
}

/**
 * What anybody opening the shop's own public page could already see - or null
 * when that page is switched off, which every caller treats exactly like "no
 * such shop". Finding or saving a shop must never reveal more than visiting it.
 */
export function toPublicShop(shop: PublicShopRow): PublicShop | null {
  if (!shop.publicPageEnabled || !shop.slug) return null;
  const base = apiEnv().APP_BASE_URL;
  const pageUrl = `${base}/s/${shop.slug}`;
  return {
    id: shop.id,
    name: shop.name,
    handle: shop.slug,
    logoUrl: shop.logoUrl,
    town:
      shop.addressCity && shop.addressRegion
        ? `${shop.addressCity}, ${shop.addressRegion}`
        : (shop.addressCity ?? null),
    pageUrl,
    bookUrl:
      shop.bookingMode === "native" ? `${base}/book/${shop.slug}` : (shop.bookingUrl ?? pageUrl),
  };
}

/**
 * Resolve what was typed. Forgiving about the SHAPE (capitals, a leading @, a
 * pasted URL - see normalizeShopHandle), never about the letters. Null for every
 * miss: unparseable input, an unknown handle, two shops that differ only by
 * dashes, and a shop whose public page is off.
 */
export async function findShopByHandle(raw: string): Promise<PublicShop | null> {
  const handle = normalizeShopHandle(raw);
  if (!handle) return null;

  let shop = await prisma.shop.findUnique({ where: { slug: handle }, select: PUBLIC_SHOP_SELECT });

  // 🔴 SECOND LOOK, SEPARATORS IGNORED - and only on a miss, so the common case
  // is still one indexed unique lookup.
  //
  // "FadesByMikey Barbershop" mints `fadesbymikey-barbershop`: one word, then
  // two, with the dash in a place nobody would guess. Comparing with the dashes
  // stripped makes every spelling of the same letters resolve, and buys no
  // ability to guess a shop nobody told you about: every letter is still
  // required, in order. Matched against the SAME expression the index is built
  // on, so this stays a single index probe rather than a scan over every shop.
  if (!shop) {
    const key = shopHandleKey(handle);
    const hit = await prisma.$queryRaw<{ slug: string }[]>(
      Prisma.sql`SELECT "slug" FROM "Shop"
                 WHERE replace("slug", '-', '') = ${key}
                 LIMIT 2`,
    );
    // Two shops whose handles differ only by dashes cannot be told apart from
    // what was typed, so neither is offered - the same answer as a miss.
    if (hit.length === 1) {
      shop = await prisma.shop.findUnique({ where: { slug: hit[0]!.slug }, select: PUBLIC_SHOP_SELECT });
    }
  }
  return shop ? toPublicShop(shop) : null;
}
