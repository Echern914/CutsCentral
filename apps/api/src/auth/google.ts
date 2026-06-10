import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apiEnv } from "@chairback/config";

const env = apiEnv();

/**
 * Google sign-in (OAuth2 authorization-code flow). Mirrors the Acuity OAuth CSRF
 * pattern: a signed, short-TTL state cookie. The code is exchanged server-to-
 * server over TLS; the returned id_token is a Google-issued JWT whose payload we
 * read for the user's sub/email/name. (We trust it because it came directly from
 * Google's token endpoint over TLS - no third-party relay.)
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_SECONDS = 10 * 60;

export const GOOGLE_STATE_COOKIE = "cb_google_oauth_state";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export function googleConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

function signState(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payloadB64).digest("base64url");
}

export function createGoogleState(nowSeconds: number): string {
  const payload = { nonce: randomBytes(16).toString("base64url"), exp: nowSeconds + STATE_TTL_SECONDS };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signState(b64)}`;
}

export function verifyGoogleState(token: string | undefined, nowSeconds: number): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signState(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      exp: number;
    };
    return typeof payload.exp === "number" && payload.exp > nowSeconds;
  } catch {
    return false;
  }
}

/**
 * Post-OAuth session handoff. The API and the web app live on DIFFERENT domains
 * (Railway vs Vercel), so a cookie set during the OAuth callback never reaches
 * the web origin. Instead the callback redirects to the web app with a signed,
 * 60-second, single-purpose code; the web server exchanges it for a real
 * session token and sets the cookie on ITS origin. The long-lived session token
 * never appears in a URL.
 */
const HANDOFF_TTL_SECONDS = 60;

// Single-use enforcement: consumed nonces are remembered until they expire.
// In-memory is sufficient for the current single-instance API deploy; a
// multi-instance deploy would need a shared store (DB row / Redis).
const consumedNonces = new Map<string, number>();

function consumeNonce(nonce: string, exp: number, nowSeconds: number): boolean {
  for (const [n, e] of consumedNonces) {
    if (e <= nowSeconds) consumedNonces.delete(n);
  }
  if (consumedNonces.has(nonce)) return false;
  consumedNonces.set(nonce, exp);
  return true;
}

export function createHandoffCode(userId: string, nowSeconds: number): string {
  const payload = {
    userId,
    purpose: "google-handoff",
    nonce: randomBytes(12).toString("base64url"),
    exp: nowSeconds + HANDOFF_TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signState(b64)}`;
}

/**
 * Returns the userId if the code is authentic, unexpired, and has never been
 * used before; otherwise null. Single-use: a replayed code (browser history,
 * proxy/access logs that captured the redirect URL) is rejected.
 */
export function verifyHandoffCode(
  code: string | undefined,
  nowSeconds: number,
): string | null {
  if (!code) return null;
  const dot = code.indexOf(".");
  if (dot <= 0) return null;
  const b64 = code.slice(0, dot);
  const sig = code.slice(dot + 1);
  const expected = signState(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      userId?: string;
      purpose?: string;
      nonce?: string;
      exp?: number;
    };
    if (payload.purpose !== "google-handoff") return null;
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

export function buildGoogleAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/** Exchange the auth code for tokens and decode the id_token payload. */
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Google response missing id_token");

  const claims = decodeJwtPayload(json.id_token);
  if (!claims.sub || !claims.email) throw new Error("Google id_token missing sub/email");
  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : String(claims.email),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}

/** Decode (not verify) a JWT payload. Safe here: token came straight from Google over TLS. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}
