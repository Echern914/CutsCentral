/**
 * ONE RULE FOR EVERY STORED OUTBOUND BODY: no URL survives into the Nudge
 * table.
 *
 * The Nudge ledger stores what we sent for history, caps and attribution -
 * but nearly every customer SMS carries a bearer URL (/r/<magicToken> is a
 * permanent rewards credential, /book/manage/<token> cancels and reschedules
 * a booking, /waitlist/offer/<token> claims a slot, /line#t=<token> tracks a
 * walk-in). Storing those bodies verbatim made the ledger a credential
 * corpus: whoever can read the table - a backup, a dump, a future admin
 * surface - holds every customer's links. The provider gets the real body in
 * memory; history gets the words with the links struck out.
 *
 * 🔴 SCHEME-AGNOSTIC ON PURPOSE. An earlier cut matched only http/https/www,
 * which would have let a deep link (chairback://r/<token> - the app's own
 * scheme, registered and already used by the mobile handoff) sail into
 * storage the day someone templated one. The matcher below takes ANY
 * `scheme://…` plus bare `www.` hosts, so a new scheme is covered before it
 * is invented rather than after it leaks.
 *
 * Deliberately NO exceptions, including the barber-typed check-in nudge that
 * the manage page renders back to the customer: a rule with a carve-out is a
 * rule the next sender forgets. A barber who types a URL into a "come early"
 * message sees it as [link] in the banner - the SMS/push the customer
 * actually received carried the real thing.
 *
 * This is the WRITE-side half. The stored history that predates it is the
 * rotation half's problem: rotating magicToken expires the whole corpus at
 * once, which no scrubber can promise.
 */

/**
 * Any absolute URI (`scheme://rest`, per RFC 3986 scheme syntax: a letter
 * followed by letters/digits/`+`/`-`/`.`) or a bare `www.` host. Both run to
 * the next whitespace, which is where an SMS URL always ends. Fragments are
 * included - `/line#t=<token>` carries its credential there.
 */
const URL_SHAPE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;

export function redactForAudit(body: string): string;
export function redactForAudit(body: string | null): string | null;
export function redactForAudit(body: string | null): string | null {
  if (body === null) return null;
  return body.replace(URL_SHAPE, "[link]");
}
