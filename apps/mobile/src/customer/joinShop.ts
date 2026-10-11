/**
 * Which shop the Join screen is about to hand this customer's name and
 * contacts to - decided by the SERVER, never by the link that opened it.
 *
 * 🔴 WHAT WAS WRONG. app/customer/join.tsx is a route, so any link can open it:
 * chairback://customer/join?handle=X&name=Y&logo=Z. It drew "Join Y" with Z's
 * logo but joined whatever shop X named - a link could dress one shop up as
 * another and collect a customer's details for it.
 *
 * Now the screen takes only the handle from its link, asks the public find-shop
 * lookup (the same one the Book tab uses) which shop that is, and shows and
 * joins exactly what came back. Until the answer arrives there is nothing to
 * join: no name, no logo, no button.
 */

export interface JoinShop {
  name: string;
  /** The server's own spelling of the handle - what the join sends. */
  handle: string;
  logoUrl: string | null;
  town: string | null;
}

export type JoinShopLookup =
  | { kind: "loading" }
  | { kind: "found"; shop: JoinShop }
  | { kind: "not_found" }
  | { kind: "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Ask the API which shop `handle` is. Never throws. */
export async function lookUpJoinShop(
  handle: string | null | undefined,
  deps: { origin: string; fetchImpl: FetchLike },
): Promise<JoinShopLookup> {
  const typed = typeof handle === "string" ? handle.trim() : "";
  if (!typed) return { kind: "not_found" };
  let res: Response;
  try {
    res = await deps.fetchImpl(`${deps.origin}/api/find-shop?handle=${encodeURIComponent(typed)}`);
  } catch {
    return { kind: "unavailable" };
  }
  // One answer for every miss, as the API gives: never a hint that a shop
  // exists but is private.
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) return { kind: "unavailable" };
  try {
    const body = (await res.json()) as { shop?: Record<string, unknown> } | null;
    const shop = body?.shop;
    const name = str(shop?.name);
    const canonical = str(shop?.handle);
    if (!name || !canonical) return { kind: "unavailable" };
    return {
      kind: "found",
      shop: { name, handle: canonical, logoUrl: str(shop?.logoUrl), town: str(shop?.town) },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface JoinScreenShop {
  /** What the screen calls the shop. */
  name: string;
  logo: string | null;
  town: string | null;
  /** The handle the Join button sends, or null: nothing to join yet. */
  joinHandle: string | null;
}

/**
 * What the screen draws: the lookup's answer and nothing else. A name or logo
 * in the link is somebody's claim, not the shop's, so it has no way in here.
 */
export function joinScreenShop(lookup: JoinShopLookup): JoinScreenShop {
  if (lookup.kind !== "found") return { name: "this shop", logo: null, town: null, joinHandle: null };
  const { shop } = lookup;
  return { name: shop.name, logo: shop.logoUrl, town: shop.town, joinHandle: shop.handle };
}
