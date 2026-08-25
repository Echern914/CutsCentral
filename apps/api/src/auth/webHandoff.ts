import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apiEnv } from "@chairback/config";

/**
 * Cross-origin session handoff for a browser OAuth callback.
 *
 * The API (Railway) and the web app (Vercel) are different origins, so a cookie
 * set during an OAuth callback never reaches the web. The callback instead
 * redirects to the web app with a signed, 60-second, SINGLE-USE code, and the
 * web server exchanges it server-to-server for a real session token that it
 * sets on its own origin. The long-lived token never appears in a URL.
 *
 * This is the same shape as the Google-specific pair in auth/google.ts, kept
 * separate rather than shared for one reason: the purpose string is inside the
 * signed payload, so a code minted for one provider cannot be redeemed on
 * another provider's endpoint. Generalizing google.ts in place would have meant
 * touching the live Google sign-in path to add a second caller.
 */

const env = apiEnv();
const HANDOFF_TTL_SECONDS = 60;

/** Consumed nonces, remembered until they expire. Single API instance today. */
const consumedNonces = new Map<string, number>();

function sign(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payloadB64).digest("base64url");
}

function consumeNonce(nonce: string, exp: number, nowSeconds: number): boolean {
  for (const [n, e] of consumedNonces) {
    if (e <= nowSeconds) consumedNonces.delete(n);
  }
  if (consumedNonces.has(nonce)) return false;
  consumedNonces.set(nonce, exp);
  return true;
}

export function createWebHandoffCode(
  userId: string,
  purpose: string,
  nowSeconds: number,
): string {
  const payload = {
    userId,
    purpose,
    nonce: randomBytes(12).toString("base64url"),
    exp: nowSeconds + HANDOFF_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/**
 * The userId if the code is authentic, unexpired, minted for THIS purpose, and
 * never used before; otherwise null. Single-use, so a code replayed out of
 * browser history or a proxy log is rejected.
 */
export function verifyWebHandoffCode(
  code: string | undefined,
  purpose: string,
  nowSeconds: number,
): string | null {
  if (!code) return null;
  const dot = code.indexOf(".");
  if (dot <= 0) return null;
  const b64 = code.slice(0, dot);
  const a = Buffer.from(code.slice(dot + 1));
  const b = Buffer.from(sign(b64));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      userId?: string;
      purpose?: string;
      nonce?: string;
      exp?: number;
    };
    if (payload.purpose !== purpose) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    if (typeof payload.userId !== "string" || typeof payload.nonce !== "string") {
      return null;
    }
    if (!consumeNonce(payload.nonce, payload.exp, nowSeconds)) return null;
    return payload.userId;
  } catch {
    return null;
  }
}
