import { createHmac } from "node:crypto";
import { apiEnv, createSession, verifySession } from "@chairback/config";

/**
 * My ChairBack customer sessions.
 *
 * Same token FORMAT as the business session (base64url payload + HMAC), signed
 * with a DIFFERENT KEY derived from SESSION_SECRET. That derivation is the
 * whole separation, and it is arithmetic rather than a check someone has to
 * remember: a customer token's signature cannot verify under the business key,
 * so it can never authenticate a dashboard route, and a barber's session can
 * never read /api/me. Neither verifier has to know the other exists.
 *
 * The payload's `userId` slot carries the CustomerAccount id - it is named for
 * the business session it shares a format with. Nothing outside this module
 * sees that name; callers get `accountId`.
 *
 * The token lives in the app's keychain and travels as a Bearer header only.
 * There is no customer cookie: no web page authenticates as a customer yet.
 */

/** Long enough that a customer who books every six weeks is still signed in. */
export const CUSTOMER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 60;

/** Demo sessions are for a look around, like the demo dashboard's. */
export const CUSTOMER_DEMO_SESSION_TTL_SECONDS = 60 * 60 * 2;

function customerKey(): string {
  // Purpose-tagged derivation, so this key can never collide with anything else
  // derived from the same secret (the phone/IP digests use their own tag).
  return createHmac("sha256", apiEnv().SESSION_SECRET)
    .update("chairback:customer_session:v1", "utf8")
    .digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface CustomerSession {
  accountId: string;
  version: number;
  demo: boolean;
}

export function mintCustomerSession(
  accountId: string,
  tokenVersion: number,
  opts: { demo?: boolean } = {},
): string {
  const demo = opts.demo === true;
  return createSession(
    accountId,
    customerKey(),
    nowSeconds(),
    demo ? CUSTOMER_DEMO_SESSION_TTL_SECONDS : CUSTOMER_SESSION_TTL_SECONDS,
    tokenVersion,
    demo,
  );
}

/** Verify a raw bearer token; null on anything but a live customer session. */
export function customerSessionFromToken(token: string | undefined): CustomerSession | null {
  const payload = verifySession(token, customerKey(), nowSeconds());
  if (!payload) return null;
  return { accountId: payload.userId, version: payload.v ?? 0, demo: payload.demo === true };
}
