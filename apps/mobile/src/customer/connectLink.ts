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

/**
 * What a link pasted under "Have a link from a shop?" opens, or null.
 *
 * `/r/<token>` (or a bare token) is the customer's personal link: that shop's
 * page as their own record, as it always was. A shop's page or booking link -
 * `/s/<handle>` or `/book/<handle>`, from a bio or a QR code - opens that page.
 * Only the PATH is taken from the paste; the screen that opens it puts it on
 * ChairBack's own origin, so a pasted link can never choose the host.
 */
export function linkTarget(raw: string): { token: string } | { path: string } | null {
  const value = raw.trim();
  const token = value.match(/\/r\/([^/?#\s]+)/)?.[1] ?? (/^[A-Za-z0-9_-]{16,}$/.test(value) ? value : null);
  if (token) {
    try {
      return { token: decodeURIComponent(token) };
    } catch {
      // A stray "%" is not a link, and must not crash the tap that pasted it.
      return null;
    }
  }
  const page = /^(?:https?:\/\/)?(?:www\.)?getchairback\.com(\/(?:s|book)\/[a-z0-9-]+)\/?(?:[?#].*)?$/i.exec(value);
  return page ? { path: page[1]!.toLowerCase() } : null;
}
