import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GCAL, apiEnv } from "@chairback/config";
import { gcalTokenSchema, type GcalToken } from "./types.js";

const env = apiEnv();

/**
 * Google Calendar OAuth. The CSRF state machinery is identical to
 * square/oauth.ts (signed {shopId,nonce,exp} in an httpOnly cookie). What
 * DIFFERS from Square:
 *   - REUSES the Google sign-in OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET)
 *     with its own redirect URI — one Google Cloud app, two flows
 *   - access_type=offline + prompt=consent so a refresh token is ALWAYS issued
 *     (Google only sends one on a consent-screen pass)
 *   - the token exchange POSTs form-encoded (not JSON) and returns a RELATIVE
 *     expires_in; access tokens last ~1 hour (refresh handled in gcal/client.ts)
 *   - the id_token (openid+email scopes) carries the account email for display.
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

/** Build the Google authorize URL for a given signed state. */
export function buildAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI ?? "",
    response_type: "code",
    scope: GCAL.scope,
    // offline = issue a refresh token (access tokens last ~1h, sync needs to
    // run unattended); consent = re-issue it on RE-connect too (Google skips
    // the refresh token on a silent re-auth of an already-granted app).
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GCAL.authorizeUrl}?${q.toString()}`;
}

/**
 * Exchange an authorization code for tokens. Google's token endpoint takes a
 * form-encoded body (unlike Square's JSON) and returns a relative expires_in.
 */
export async function exchangeCodeForToken(code: string): Promise<GcalToken> {
  const res = await fetch(GCAL.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI ?? "",
    }),
  });
  if (!res.ok) {
    // Google's error body carries the real reason ("invalid_client",
    // "redirect_uri_mismatch", "invalid_grant" for a stale/reused code).
    const body = await res.text().catch(() => "");
    throw new GcalTokenExchangeError(res.status, body);
  }
  return gcalTokenSchema.parse(await res.json());
}

/** Token-exchange failure that carries Google's HTTP status + raw error body. */
export class GcalTokenExchangeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Google token exchange failed: ${status} ${body}`);
  }
}

/**
 * Pull the account email out of the id_token for the dashboard card. NO
 * signature verification: this JWT arrived directly from Google's token
 * endpoint over TLS in the same server-side request (it was never in a
 * client's hands), so its payload is as trusted as the access_token beside it.
 */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export const OAUTH_STATE_COOKIE = "cb_gcal_oauth_state";
