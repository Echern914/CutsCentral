import { createHash, createHmac } from "node:crypto";
import { apiEnv } from "@chairback/config";

/**
 * THE UNSUBSCRIBE CREDENTIAL, AND NOTHING ELSE.
 *
 * 🔴 WHY THIS EXISTS AT ALL. The first cut of broadcast email put
 * `Client.magicToken` in the footer of every marketing message. That token is
 * the customer's WHOLE REWARDS SESSION - their visit history, their punch
 * cards, their appointments, their contact details, their opt-out settings -
 * and a promotional email is the most-forwarded, most-screenshotted,
 * most-scanned thing a shop sends. Mailing a session key to a few thousand
 * people every time a barber runs a promotion is not a tradeoff; it is a
 * credential handed out at scale for a link whose entire job is to set one
 * boolean to true.
 *
 * What this grants: `emailOptedOut = true`. It cannot open the rewards page,
 * read an appointment, reach any customer data, or be exchanged for anything
 * that can. If one leaks, the worst case is that somebody stops a shop's
 * marketing from reaching one person - which is, after all, what the link is
 * for.
 *
 * ── Derived, not stored ─────────────────────────────────────────────────────
 *
 * The raw token is an HMAC of the client id under the platform secret, so it
 * is:
 *   - UNGUESSABLE without the secret (256 bits of it),
 *   - STABLE, which CAN-SPAM requires - an unsubscribe link has to keep
 *     working for at least 30 days after the mail was sent, and a freshly
 *     minted token per send would break every link in every earlier email,
 *   - NEVER PERSISTED IN THE CLEAR. Only the SHA-256 digest is written, purely
 *     so a presented token can be looked up in one indexed read. A leaked
 *     database backup yields digests, and a digest cannot be mailed to anyone.
 *
 * The purpose string is domain separation: the same secret signs session
 * cookies and affiliate attribution, and a value minted here must never be
 * mistakable for one of those (or vice versa). The `v1` is what lets the
 * scheme be rotated later without ambiguity.
 *
 * ROTATING SESSION_SECRET invalidates every outstanding unsubscribe link along
 * with every session - deliberately noted here so it is a known consequence
 * rather than a surprise. Nothing else breaks: `magicToken` is untouched, so
 * rewards sessions are unaffected by anything in this file.
 */

const PURPOSE = "chairback:unsubscribe:v1";

/** The token that goes in ONE customer's unsubscribe link. */
export function unsubscribeTokenFor(clientId: string): string {
  return createHmac("sha256", apiEnv().SESSION_SECRET)
    .update(`${PURPOSE}:${clientId}`)
    .digest("base64url");
}

/** What is stored: the digest of the token, never the token. */
export function unsubscribeTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The digest for a client, in one step - what a send writes before mailing. */
export function unsubscribeDigestFor(clientId: string): string {
  return unsubscribeTokenDigest(unsubscribeTokenFor(clientId));
}
