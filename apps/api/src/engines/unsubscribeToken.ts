import { createHash, createHmac } from "node:crypto";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

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
 * The purpose string is domain separation: a value minted here must never be
 * mistakable for a session signature or an affiliate attribution (or vice
 * versa). The `v1` is what lets the scheme be replaced later without ambiguity.
 *
 * ── Its own key, for its own lifetime ───────────────────────────────────────
 *
 * 🔴 THIS USED TO DERIVE FROM SESSION_SECRET, AND THAT WAS WRONG. Whatever
 * signs these tokens decides how long a link in a three-week-old email keeps
 * working - so tying them to the session key tied an unsubscribe's lifetime to
 * a value whose entire purpose is to be rotatable. Rotate sessions after a
 * leak, on a schedule, or because somebody left, and every outstanding
 * unsubscribe link silently stops matching: not at rotation, which would at
 * least be noticeable, but at each client's NEXT broadcast, when the worker
 * derives a new token and overwrites their stored digest. CAN-SPAM requires
 * the opposite, and a link that does nothing is how a customer stops clicking
 * unsubscribe and starts clicking "this is spam".
 *
 * UNSUBSCRIBE_TOKEN_SECRET is therefore separate and long-lived. Production
 * REFUSES TO BOOT without it (see packages/config/src/env.ts) rather than
 * falling back, because a fallback nobody is told about is how this quietly
 * becomes one secret again. Development and CI may fall back, once, loudly.
 *
 * The guarantee this buys, stated exactly: an unsubscribe link keeps working
 * for the life of UNSUBSCRIBE_TOKEN_SECRET. Rotating THAT key does invalidate
 * every outstanding link - it is the one action that should, and it is now a
 * deliberate act rather than a side effect of unrelated hygiene.
 *
 * Nothing here touches `magicToken`, so rewards sessions are unaffected by any
 * of it.
 */

const PURPOSE = "chairback:unsubscribe:v1";

let warnedAboutFallback = false;

/**
 * The key these tokens are derived from.
 *
 * Unreachable in production: the environment schema refuses to start without
 * the dedicated secret. Everywhere else the fallback is announced once, so a
 * developer who later wonders why a staging unsubscribe link stopped working
 * after a session rotation has the answer in the log rather than in a bisect.
 */
function signingKey(): string {
  const env = apiEnv();
  if (env.UNSUBSCRIBE_TOKEN_SECRET) return env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    logger.warn(
      { reason: "unsubscribe_token_secret_unset" },
      "UNSUBSCRIBE_TOKEN_SECRET is not set - deriving unsubscribe tokens from the session key. Outstanding links will break if sessions are rotated. Production refuses to start in this state.",
    );
  }
  // Domain-separated even here, so a fallback token is not a session signature
  // by another name.
  return `${PURPOSE}:fallback:${env.SESSION_SECRET}`;
}

/** The token that goes in ONE customer's unsubscribe link. */
export function unsubscribeTokenFor(clientId: string): string {
  return createHmac("sha256", signingKey())
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
