/**
 * ONE RULE FOR EVERY STORED OUTBOUND BODY: no URL survives into the Nudge
 * table.
 *
 * The Nudge ledger stores what we sent for history, caps and attribution -
 * but nearly every customer SMS carries a bearer URL (/r/<magicToken> is a
 * permanent rewards credential, /book/manage/<token> cancels and reschedules
 * a booking, waitlist and walk-in links act without login). Storing those
 * bodies verbatim made the ledger a credential corpus: whoever can read the
 * table - a backup, a dump, a future admin surface - holds every customer's
 * links. The provider gets the real body in memory; history gets the words
 * with the links struck out.
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

const URL_SHAPE = /(?:https?:\/\/|www\.)\S+/gi;

export function redactForAudit(body: string): string;
export function redactForAudit(body: string | null): string | null;
export function redactForAudit(body: string | null): string | null {
  if (body === null) return null;
  return body.replace(URL_SHAPE, "[link]");
}
