import { ApiError, type ApiClient } from "./api";

/**
 * What "Book again" repeats: one booking (its event id, "a_..." / "v_..."), or
 * the customer's usual at that shop (the rewards card, which names none).
 */
export const BOOK_AGAIN_USUAL = "usual";

/**
 * Which page the shop screen opens, and from where.
 *
 * Plain: the storefront (/api/me/shops/:key/storefront). "Book again": the
 * API's book-again link - the shop's booking page with the booking's service
 * and provider preselected, which the page lands on the time step for. The
 * API decides what can be preselected and falls back to the storefront by
 * itself (services/customerPortal.ts bookAgainUrl), so the app never builds
 * a booking URL or guesses an id.
 */
export function shopPagePath(key: string, again: string | null | undefined): string {
  const shop = `/api/me/shops/${encodeURIComponent(key)}`;
  if (!again) return `${shop}/storefront`;
  return again === BOOK_AGAIN_USUAL
    ? `${shop}/book-again`
    : `${shop}/book-again?appointment=${encodeURIComponent(again)}`;
}

/**
 * The URL to open. 🔴 An API from before "Book again" answers 404 for it: the
 * app then opens the storefront - what Book again always did - rather than an
 * error screen. (The app ships through the App Store; the API can lag it.)
 */
export async function loadShopPage(
  api: Pick<ApiClient, "get">,
  key: string,
  again: string | null | undefined,
): Promise<string> {
  try {
    return (await api.get<{ url: string }>(shopPagePath(key, again))).url;
  } catch (err) {
    if (!again || !(err instanceof ApiError) || err.kind !== "not_found") throw err;
    return (await api.get<{ url: string }>(shopPagePath(key, null))).url;
  }
}
