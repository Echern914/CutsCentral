import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SQUARE, apiEnv, squareHost } from "@chairback/config";
import { squareTokenSchema, type SquareToken } from "./types.js";

const env = apiEnv();

/**
 * Square OAuth. The CSRF state machinery is identical to acuity/oauth.ts (signed
 * {shopId,nonce,exp} in an httpOnly cookie). What DIFFERS from Acuity:
 *   - host is env-selected (sandbox vs production) via squareHost(SQUARE_ENV)
 *   - the token exchange POSTs JSON (not form-encoded) with client_secret
 *   - the response carries merchant_id + an absolute expires_at (not expires_in)
 *   - access tokens expire (~30 days) and the refresh token is required (refresh
 *     handled in square/client.ts).
 */
export interface OAuthState {
  shopId: string;
  nonce: string;
  exp: number; // epoch seconds
  /**
   * True when this authorization was started for CALENDAR PROTECTION, i.e. with
   * SQUARE.outboundScope rather than the read-only default.
   *
   * Carried in the signed state rather than re-derived at the callback because
   * the callback has no other way to know which consent screen the seller
   * actually saw - and recording "we asked for write scopes" when we did not
   * would make the stored `scope` a lie. Optional so a state minted by the
   * previous deploy still verifies (absent = the narrow, read-only flow).
   */
  outbound?: boolean;
}

const STATE_TTL_SECONDS = 10 * 60;

function signState(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function createOAuthState(
  shopId: string,
  nowSeconds: number,
  outbound = false,
): string {
  const payload: OAuthState = {
    shopId,
    nonce: randomBytes(16).toString("base64url"),
    exp: nowSeconds + STATE_TTL_SECONDS,
    ...(outbound ? { outbound: true } : {}),
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

/**
 * Build the Square authorize URL for a given signed state.
 *
 * `scope` defaults to the READ-ONLY set every ordinary connect has always
 * asked for. The wider outbound set (SQUARE.outboundScope, which includes
 * APPOINTMENTS_WRITE / APPOINTMENTS_ALL_WRITE) is requested ONLY when a manager
 * explicitly opts the shop into calendar protection.
 *
 * Kept opt-in rather than folded into the default because widening the default
 * changes the consent screen every seller sees at connect time - for a
 * capability most of them are not on a Square plan to use - and a connect flow
 * that fails is a worse regression than a feature nobody armed.
 */
export function buildAuthorizeUrl(state: string, scope: string = SQUARE.scope): string {
  const q = new URLSearchParams({
    client_id: env.SQUARE_OAUTH_CLIENT_ID ?? "",
    scope,
    session: "false", // force the seller to explicitly authorize
    state,
  });
  if (env.SQUARE_OAUTH_REDIRECT_URI) q.set("redirect_uri", env.SQUARE_OAUTH_REDIRECT_URI);
  return `${squareHost(env.SQUARE_ENV)}${SQUARE.authorizePath}?${q.toString()}`;
}

/**
 * Exchange an authorization code for tokens. Square's ObtainToken takes a JSON
 * body (unlike Acuity's form encoding) and returns merchant_id + expires_at.
 * [VERIFY IN SANDBOX] the exact body field names + content type.
 */
export async function exchangeCodeForToken(code: string): Promise<SquareToken> {
  const res = await fetch(`${squareHost(env.SQUARE_ENV)}${SQUARE.tokenPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": env.SQUARE_API_VERSION ?? SQUARE.apiVersion,
    },
    body: JSON.stringify({
      client_id: env.SQUARE_OAUTH_CLIENT_ID,
      client_secret: env.SQUARE_OAUTH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      ...(env.SQUARE_OAUTH_REDIRECT_URI ? { redirect_uri: env.SQUARE_OAUTH_REDIRECT_URI } : {}),
    }),
  });
  if (!res.ok) {
    // Capture Square's error body — it carries the real reason (e.g. "invalid_client"
    // for a bad client_id/secret pair, "invalid_grant" for a stale/reused code or
    // redirect_uri mismatch). Without it the callback only sees an opaque status.
    const body = await res.text().catch(() => "");
    throw new SquareTokenExchangeError(res.status, body);
  }
  return squareTokenSchema.parse(await res.json());
}

/** Token-exchange failure that carries Square's HTTP status + raw error body. */
export class SquareTokenExchangeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Square token exchange failed: ${status} ${body}`);
  }
}

export const OAUTH_STATE_COOKIE = "cb_square_oauth_state";
