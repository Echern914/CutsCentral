import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8, jwtVerify } from "jose";
import { apiEnv } from "@chairback/config";
import { appleJwks } from "./native.js";

/**
 * Sign in with Apple on the WEB (the authorization-code flow), as opposed to
 * the native iOS one in auth/native.ts.
 *
 * WHY THE WEB NEEDS IT AT ALL. The invited-barber "Join your shop" flow signs
 * people up in the system authentication browser, and a barber whose phone
 * account is an Apple ID would otherwise have to invent a password to accept an
 * invitation - having just been shown an Apple button on the previous screen.
 *
 * TWO THINGS DIFFER FROM GOOGLE and both bite if you assume symmetry:
 *  1. The client secret is not a string you paste. It is an ES256 JWT you SIGN,
 *     per request, with a .p8 key from the Apple Developer console. It is
 *     minted fresh here (5 minute lifetime) rather than cached, so a clock skew
 *     or a rotated key surfaces immediately instead of hours later.
 *  2. Apple answers the redirect with a cross-site FORM POST (response_mode is
 *     form_post whenever name/email scopes are requested), so a SameSite=Lax
 *     state cookie is NOT sent back. That is why state here is a signed,
 *     self-verifying value rather than a cookie comparison - the signature and
 *     TTL are the CSRF defense, and they travel in the state itself.
 *
 * DARK UNTIL CONFIGURED. With any of the Apple env vars unset,
 * appleWebConfigured() is false, the button never renders, and the routes 503.
 * Nothing about the existing Google or password flows changes.
 */

const env = apiEnv();

const AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_ISSUER = "https://appleid.apple.com";
const STATE_TTL_SECONDS = 10 * 60;
/** Apple caps the client secret at 6 months; short is strictly better here. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export interface AppleWebProfile {
  sub: string;
  email: string;
  /** Apple sends a name only on the FIRST authorization, in the form post. */
  name: string | null;
  emailVerified: boolean;
}

export function appleWebConfigured(): boolean {
  return Boolean(
    env.APPLE_OAUTH_SERVICES_ID &&
      env.APPLE_OAUTH_TEAM_ID &&
      env.APPLE_OAUTH_KEY_ID &&
      env.APPLE_OAUTH_PRIVATE_KEY &&
      env.APPLE_OAUTH_REDIRECT_URI,
  );
}

function signState(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payloadB64).digest("base64url");
}

/**
 * A signed, expiring state. `purpose` is part of the signed payload so an Apple
 * state can never be replayed into the Google callback (or the other way
 * round) even though both are signed with the same secret.
 */
export function createAppleState(nowSeconds: number): string {
  const payload = {
    purpose: "apple-oauth",
    nonce: randomBytes(16).toString("base64url"),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signState(b64)}`;
}

export function verifyAppleState(
  token: string | undefined,
  nowSeconds: number,
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(signState(b64));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      purpose?: string;
      exp?: number;
    };
    return (
      payload.purpose === "apple-oauth" &&
      typeof payload.exp === "number" &&
      payload.exp > nowSeconds
    );
  } catch {
    return false;
  }
}

export function buildAppleAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.APPLE_OAUTH_SERVICES_ID!,
    redirect_uri: env.APPLE_OAUTH_REDIRECT_URI!,
    scope: "name email",
    // Requesting name/email forces form_post; setting it explicitly documents
    // that the callback is a POST and keeps Apple from silently choosing.
    response_mode: "form_post",
    state,
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * The per-request ES256 client secret. The .p8 arrives through an env var, so
 * it commonly carries literal backslash-n instead of real newlines - PKCS8
 * import fails cryptically on that, hence the normalization.
 */
export async function createAppleClientSecret(nowSeconds: number): Promise<string> {
  const pem = env.APPLE_OAUTH_PRIVATE_KEY!.replace(/\\n/g, "\n").trim();
  const key = await importPKCS8(pem, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_OAUTH_KEY_ID! })
    .setIssuer(env.APPLE_OAUTH_TEAM_ID!)
    .setAudience(APPLE_ISSUER)
    .setSubject(env.APPLE_OAUTH_SERVICES_ID!)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

/**
 * Exchange the authorization code for an id_token and read the identity out of
 * it.
 *
 * The id_token is VERIFIED against Apple's published keys rather than merely
 * decoded. Google's exchange decodes, on the argument that the token came
 * straight from Google's endpoint over TLS; the same argument would apply here,
 * but Apple's relay-email behavior makes this token the sole basis for account
 * linking, so it gets the stricter treatment for the cost of one cached JWKS
 * lookup.
 *
 * `userJson` is Apple's first-authorization-only name payload, forwarded from
 * the form post. It is NOT authenticated (it is a form field, not a claim), so
 * it may only ever supply a display name - never an email or an identity.
 */
export async function exchangeAppleCode(
  code: string,
  userJson?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AppleWebProfile> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.APPLE_OAUTH_SERVICES_ID!,
    client_secret: await createAppleClientSecret(nowSeconds),
    redirect_uri: env.APPLE_OAUTH_REDIRECT_URI!,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Apple token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Apple response missing id_token");

  const { payload } = await jwtVerify(json.id_token, appleJwks, {
    issuer: APPLE_ISSUER,
    audience: env.APPLE_OAUTH_SERVICES_ID!,
  });
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!payload.sub || !email) throw new Error("Apple id_token missing sub/email");

  return {
    sub: String(payload.sub),
    email,
    name: nameFromUserJson(userJson),
    // Apple encodes this as boolean true or the string "true".
    emailVerified:
      payload.email_verified === true || payload.email_verified === "true",
  };
}

/** Flatten Apple's {"name":{"firstName","lastName"}} form field, if present. */
function nameFromUserJson(userJson?: string): string | null {
  if (!userJson) return null;
  try {
    const parsed = JSON.parse(userJson) as {
      name?: { firstName?: string; lastName?: string };
    };
    const full = [parsed.name?.firstName, parsed.name?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    return full ? full.slice(0, 120) : null;
  } catch {
    return null;
  }
}
