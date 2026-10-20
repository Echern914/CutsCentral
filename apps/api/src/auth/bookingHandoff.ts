import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEnv } from "@chairback/config";
import { BOOKING_HANDOFF_PARAM } from "@chairback/config/bookingHandoff";

/**
 * "WHO IS BOOKING" FOR A PAGE OPENED FROM THE APP.
 *
 * My ChairBack books on the shop's own web page, inside a WebView. The app's
 * customer session is a Bearer token in the keychain and never reaches that
 * page, so the booking used to arrive as a stranger's: typed details only, and
 * a typed phone or email decides which client record it lands on. Whenever
 * that was not the record the account is linked to, the booking existed and
 * the app said "Nothing is booked right now."
 *
 * The API already hands the app every URL it opens on a shop's page (the
 * storefront, a saved shop's Book link). It now signs one of these into those
 * URLs, the pages carry it to the booking, and the booking API reads it back.
 *
 * 🔴 WHAT IT IS - and what it is not:
 *   - One account, one shop. A handoff minted for one shop books nothing at
 *     another (the shop is inside the signed payload).
 *   - Short-lived, and dead the moment the account signs out everywhere or is
 *     deleted (the account's tokenVersion is inside it too).
 *   - It never AUTHENTICATES anything. Its only power is to say which of the
 *     account's OWN records a booking lands on (services/appBooking.ts) -
 *     every rule about who may see a record stays in customerIdentity.ts.
 *   - It cannot become a session, nor a session it: each is signed with its
 *     own key derived from SESSION_SECRET (bookingHandoff.test.ts proves both).
 */

/** Long enough to browse a storefront and pick a time; short enough to be worthless when copied. */
export const BOOKING_HANDOFF_TTL_SECONDS = 4 * 60 * 60;
const PURPOSE = "customer_booking_v1";

function handoffKey(): string {
  return createHmac("sha256", apiEnv().SESSION_SECRET)
    .update("chairback:customer_booking_handoff:v1", "utf8")
    .digest("hex");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", handoffKey()).update(payloadB64).digest("base64url");
}

interface Payload {
  purpose: string;
  /** CustomerAccount id. */
  a: string;
  /** Shop id. */
  s: string;
  /** The account's tokenVersion when minted. */
  v: number;
  exp: number;
}

export function mintBookingHandoff(
  p: { accountId: string; shopId: string; tokenVersion: number },
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload: Payload = {
    purpose: PURPOSE,
    a: p.accountId,
    s: p.shopId,
    v: p.tokenVersion,
    exp: nowSeconds + BOOKING_HANDOFF_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/**
 * The account and version a handoff names, if it is authentic, unexpired and
 * minted for THIS shop. Null on anything else - never throws. The caller still
 * checks the version against the account (sign-out everywhere revokes it).
 */
export function readBookingHandoff(
  token: string | undefined | null,
  shopId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { accountId: string; tokenVersion: number } | null {
  if (!token || token.length > 1000) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(b64));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Partial<Payload>;
    if (p.purpose !== PURPOSE) return null;
    if (typeof p.a !== "string" || typeof p.s !== "string" || typeof p.v !== "number") return null;
    if (typeof p.exp !== "number" || p.exp <= nowSeconds) return null;
    if (p.s !== shopId) return null;
    return { accountId: p.a, tokenVersion: p.v };
  } catch {
    return null;
  }
}

/** `url` with the handoff appended (keeps any query it already has). */
export function withBookingHandoff(url: string, handoff: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${BOOKING_HANDOFF_PARAM}=${encodeURIComponent(handoff)}`;
}
