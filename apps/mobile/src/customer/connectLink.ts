/**
 * Is this a ChairBack link that can never connect a profile - the shop's own
 * page or booking link rather than the customer's personal /r/ link?
 *
 * Mirrors the server's `tokenFromLink` (routes/customerMe.ts): a personal link
 * is `/r/<16-128 url-safe chars>`. Anything else on getchairback.com is the
 * link every customer of that shop has, so the connect screen answers it
 * without a request - and says which link it needs instead of the generic
 * "doesn't match". A bare token, or text that is not a ChairBack link at all,
 * is left for the server to judge.
 */
export function isShopLinkNotPersonal(raw: string): boolean {
  const value = raw.trim();
  if (!/getchairback\.com/i.test(value)) return false;
  return !/\/r\/[A-Za-z0-9_-]{16,128}/.test(value);
}
