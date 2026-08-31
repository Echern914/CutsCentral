import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apiEnv } from "@chairback/config";
import { stripeClient } from "./stripe.js";

/**
 * Stripe Connect STANDARD onboarding, via OAuth.
 *
 * The other door — Express — is in connect.ts: we create the account, Stripe
 * hosts a signup form, and the barber ends up with a new Stripe-managed account
 * they did not previously have. This module is for the barber who ALREADY has a
 * Stripe account and wants to use it: they log in at Stripe, tap Authorize, and
 * we receive the id of the account they chose.
 *
 * 🔴 BOTH DOORS PRODUCE THE SAME THING: an `acct_…` stored on
 * `Shop.stripeConnectAccountId`. Every charge, payout, Terminal call and webhook
 * downstream is IDENTICAL for the two types — we take destination charges with
 * `on_behalf_of` (see payments.ts), never charges on the connected account, so
 * nothing downstream needs to know which door was used. `stripeConnectAccountType`
 * exists to explain the account to a HUMAN (and to decide whether "Finish setup"
 * can reopen a hosted form), never to branch payment behaviour.
 *
 * 🔴 THE ONE REAL DIFFERENCE IS REVOCATION. A Standard account holder can
 * disconnect ChairBack from their own Stripe dashboard at any time, without
 * touching ours. That arrives as `account.application.deauthorized` and is
 * handled in connect.ts — without it the shop keeps reading as "connected" while
 * every charge fails. An Express account cannot do this.
 */

/** `read_write`: we create PaymentIntents and read account status on their behalf. */
const CONNECT_SCOPE = "read_write";

const STATE_TTL_SECONDS = 10 * 60;

export const CONNECT_OAUTH_STATE_COOKIE = "cb_stripe_connect_state";

/**
 * CSRF state: a signed token binding one OAuth round-trip to one shop, with a
 * nonce and a short expiry. Written to an httpOnly cookie on /start and required
 * to match the returned `state` on /callback — so a code delivered to a browser
 * that never started the flow cannot attach an account to someone else's shop.
 *
 * Deliberately identical in shape to the Acuity one (acuity/oauth.ts) rather
 * than clever: same signing key, same format, same failure mode.
 */
export interface ConnectOAuthState {
  shopId: string;
  nonce: string;
  exp: number; // epoch seconds
}

function signState(payloadB64: string): string {
  return createHmac("sha256", apiEnv().SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function createConnectState(shopId: string, nowSeconds: number): string {
  const payload: ConnectOAuthState = {
    shopId,
    nonce: randomBytes(16).toString("base64url"),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signState(b64)}`;
}

export function verifyConnectState(
  token: string | undefined | null,
  nowSeconds: number,
): ConnectOAuthState | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signState(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual THROWS on a length mismatch, and a
  // forged state of the wrong length is the easiest thing for an attacker to send.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(b64, "base64url").toString("utf8"),
    ) as ConnectOAuthState;
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
 * Standard onboarding needs its own credential — the platform's OAuth client id,
 * which is separate from the secret key. Without it the button must not appear
 * at all, so this is the seam the UI gates on (mirrors connectEnabled()).
 */
export function standardConnectEnabled(): boolean {
  const env = apiEnv();
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_CONNECT_CLIENT_ID);
}

/**
 * Where Stripe sends the barber back. Must EXACTLY match a redirect URI
 * registered in the Stripe dashboard's Connect settings, or Stripe refuses the
 * authorize request before the barber sees anything.
 */
export function connectRedirectUri(): string {
  return `${apiEnv().API_BASE_URL}/api/payments/connect/oauth/callback`;
}

/**
 * The Stripe-hosted authorize URL. `stripe_landing: "login"` because this door
 * is specifically for someone who already HAS an account — the register screen
 * is what the Express door is for.
 */
export function buildConnectAuthorizeUrl(state: string, email?: string | null): string {
  return stripeClient().oauth.authorizeUrl({
    client_id: apiEnv().STRIPE_CONNECT_CLIENT_ID,
    response_type: "code",
    scope: CONNECT_SCOPE,
    redirect_uri: connectRedirectUri(),
    stripe_landing: "login",
    state,
    // Prefill only. Stripe ignores an invalid value rather than erroring, and the
    // barber can still pick any account they control.
    ...(email ? { stripe_user: { email } } : {}),
  });
}

/**
 * Exchange the authorization code for the CONNECTED ACCOUNT ID.
 *
 * 🔴 We deliberately keep only `stripe_user_id` and throw the access token away.
 * Destination charges are made with the PLATFORM key, so the token buys us
 * nothing we need — and an unused stored credential is pure liability. Nothing
 * downstream ever wants it.
 */
export async function exchangeConnectCode(code: string): Promise<string> {
  const token = await stripeClient().oauth.token({
    grant_type: "authorization_code",
    code,
  });
  const accountId = token.stripe_user_id;
  if (!accountId) throw new Error("stripe_oauth_no_account_id");
  return accountId;
}
