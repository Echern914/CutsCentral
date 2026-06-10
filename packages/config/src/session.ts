import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed session tokens for barber auth. Format:
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 *
 * The payload is {userId, iat, exp}. Verification is constant-time and checks
 * expiry. Shared by the Express API (the real gate) and the Next middleware
 * (presence/expiry check for UX redirects).
 */

export interface SessionPayload {
  userId: string;
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds) */
  exp: number;
  /** token version for revocation; tokens minted before the field default to 0 */
  v?: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

/**
 * Create a signed session token.
 * @param nowSeconds current epoch seconds (pass in for determinism/testability)
 */
export function createSession(
  userId: string,
  secret: string,
  nowSeconds: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  version = 0,
): string {
  const payload: SessionPayload = {
    userId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    v: version,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * Verify a session token. Returns the payload if the signature is valid and
 * the token is not expired; otherwise null. Never throws on bad input.
 */
export function verifySession(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number,
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowSeconds
  ) {
    return null;
  }
  return payload;
}

export { SESSION_COOKIE_NAME } from "./constants.js";
