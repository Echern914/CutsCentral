/**
 * Incoming links, rewritten before the router sees them.
 *
 * A shop's link is https://getchairback.com/r/<token> (a universal link) or
 * chairback://r/<token>. There is no /r route in this app - the old customer
 * screen used to fish the token out of Linking once it had mounted - so left
 * alone, the router would land on its "unmatched route" screen. Here it
 * becomes /customer/link?token=..., which opens that shop's page inside My
 * ChairBack with a way back.
 *
 * /book/* is the SECOND family, and the one most customers actually arrive on:
 * every QR code a shop prints encodes https://getchairback.com/book/<slug>.
 * The web host now claims that path in its apple-app-site-association, so a
 * scan on a phone with the app installed comes here instead of opening Safari.
 *
 * 🔴 BOTH /book/<slug> AND /book/manage/<token> GO TO THE SAME PLACE, and that
 * is deliberate. The obvious-looking alternative for the second one -
 * /customer/manage/[id] - is wrong twice over: it wants an APPOINTMENT ID and
 * resolves the page through /api/me, so it needs a signed-in customer. A manage
 * link is the no-login path, authenticated by the token in the URL itself, and
 * the person tapping it may have no ChairBack account at all. /customer/link is
 * open to a signed-out customer (see the gate in app/customer/_layout.tsx), so
 * it serves the whole /book/* space without asking anyone to sign in first.
 *
 * The tail is forwarded VERBATIM, query string included, so a ?service=/?staff=
 * prefill from a shop's targeted link survives the hop into the app.
 *
 * Every other path (the team-invitation and sign-in callbacks) passes through
 * untouched. A malformed URL goes to the start, never to a crash.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const m = /\/r\/([^/?#]+)/.exec(path);
    if (m) return `/customer/link?token=${encodeURIComponent(decodeURIComponent(m[1]!))}`;
    // Anything under /book: the shop's booking page, or a manage link.
    const book = /\/book\/([^?#]+)(\?[^#]*)?/.exec(path);
    if (book) {
      const tail = `/book/${book[1]}${book[2] ?? ""}`;
      return `/customer/link?path=${encodeURIComponent(tail)}`;
    }
    return path;
  } catch {
    return "/";
  }
}
