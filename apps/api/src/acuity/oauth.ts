import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ACUITY, apiEnv } from "@chairback/config";
import { acuityTokenSchema, type AcuityToken } from "./types.js";

const env = apiEnv();

/**
 * OAuth CSRF state. The state is a signed token binding the OAuth round-trip to
 * a specific shop + a random nonce, with a short TTL. Stored in an httpOnly
 * cookie on /start and validated on /callback before any token exchange.
 *
 * Format: base64url(JSON{shopId,nonce,exp}) + "." + HMAC. Reuses SESSION_SECRET.
 */
export interface OAuthState {
  shopId: string;
  nonce: string;
  exp: number; // epoch seconds
}

const STATE_TTL_SECONDS = 10 * 60;

function signState(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function createOAuthState(shopId: string, nowSeconds: number): string {
  const payload: OAuthState = {
    shopId,
    nonce: randomBytes(16).toString("base64url"),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signState(b64)}`;
}

export function verifyOAuthState(
  token: string | undefined | null,
  nowSeconds: number,
): OAuthState | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signState(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(b64, "base64url").toString("utf8"),
    ) as OAuthState;
    if (
      typeof payload.shopId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Build the Acuity authorize URL for a given signed state. */
export function buildAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    scope: ACUITY.scope,
    client_id: env.ACUITY_OAUTH_CLIENT_ID,
    redirect_uri: env.ACUITY_OAUTH_REDIRECT_URI,
    state,
  });
  return `${ACUITY.authorizeUrl}?${q.toString()}`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForToken(code: string): Promise<AcuityToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.ACUITY_OAUTH_REDIRECT_URI,
    client_id: env.ACUITY_OAUTH_CLIENT_ID,
    client_secret: env.ACUITY_OAUTH_CLIENT_SECRET,
  });
  const res = await fetch(ACUITY.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Acuity token exchange failed: ${res.status}`);
  }
  return acuityTokenSchema.parse(await res.json());
}

export const OAUTH_STATE_COOKIE = "cb_acuity_oauth_state";
