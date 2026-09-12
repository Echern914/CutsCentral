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
 * Every other path (the team-invitation and sign-in callbacks) passes through
 * untouched. A malformed URL goes to the start, never to a crash.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const m = /\/r\/([^/?#]+)/.exec(path);
    if (m) return `/customer/link?token=${encodeURIComponent(decodeURIComponent(m[1]!))}`;
    return path;
  } catch {
    return "/";
  }
}
