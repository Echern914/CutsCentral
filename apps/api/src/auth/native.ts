import { createRemoteJWKSet, jwtVerify } from "jose";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { mintSessionToken } from "./session.js";

const env = apiEnv();

/**
 * Native iOS sign-in: verify an identity token issued by Apple or Google to the
 * MOBILE app, then find the barber User and mint a session token the app stores
 * and sends as `Authorization: Bearer`. Matches by provider id, else links by
 * verified email - so a barber has ONE account regardless of how they signed
 * in. Unlike the web Google flow this NEVER creates an account: App Store
 * Guideline 3.1.1 (no in-app business registration) - sign-up is web-only.
 *
 * We verify the JWT ourselves against the provider's published public keys
 * (JWKS), checking issuer + audience, so a forged token can't mint a session.
 */

// Provider JWKS, fetched + cached by jose. Apple and Google both publish here.
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface NativeProfile {
  sub: string; // the provider's stable user id
  email: string | null;
  name: string | null;
  // Whether the PROVIDER attests the email is verified. Linking a social login
  // into an existing account by email is only safe when this is true —
  // otherwise a provider account with an unverified (attacker-chosen) email
  // could take over the ChairBack account that legitimately owns that email.
  emailVerified: boolean;
}

export class NativeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Whether Apple native sign-in is configured (bundle id to check audience). */
export function appleNativeEnabled(): boolean {
  return Boolean(env.APPLE_BUNDLE_ID);
}

/** Whether Google native sign-in is configured (iOS OAuth client id). */
export function googleNativeEnabled(): boolean {
  return Boolean(env.GOOGLE_OAUTH_IOS_CLIENT_ID);
}

/**
 * Verify an Apple identityToken. Audience must be our app's bundle id; issuer
 * must be Apple. `name` is never in the token (Apple only sends it once, in the
 * authorization response, which the app forwards separately if present).
 */
export async function verifyApple(
  identityToken: string,
  nameFromApp?: string | null,
): Promise<NativeProfile> {
  if (!env.APPLE_BUNDLE_ID) {
    throw new NativeAuthError("apple_native_unconfigured", 503);
  }
  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: env.APPLE_BUNDLE_ID,
    });
    if (!payload.sub) throw new NativeAuthError("apple_token_no_sub", 401);
    return {
      sub: payload.sub,
      email: (payload.email as string | undefined) ?? null,
      name: nameFromApp ?? null,
      // Apple encodes this as boolean true or the string "true".
      emailVerified:
        payload.email_verified === true || payload.email_verified === "true",
    };
  } catch (err) {
    if (err instanceof NativeAuthError) throw err;
    throw new NativeAuthError("apple_token_invalid", 401);
  }
}

/**
 * Verify a Google idToken from the iOS SDK. Audience must be our iOS OAuth
 * client id; issuer must be Google. Google includes name + email in the token.
 */
export async function verifyGoogle(idToken: string): Promise<NativeProfile> {
  if (!env.GOOGLE_OAUTH_IOS_CLIENT_ID) {
    throw new NativeAuthError("google_native_unconfigured", 503);
  }
  try {
    const { payload } = await jwtVerify(idToken, googleJwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.GOOGLE_OAUTH_IOS_CLIENT_ID,
    });
    if (!payload.sub) throw new NativeAuthError("google_token_no_sub", 401);
    return {
      sub: payload.sub,
      email: (payload.email as string | undefined) ?? null,
      name: (payload.name as string | undefined) ?? null,
      emailVerified:
        payload.email_verified === true || payload.email_verified === "true",
    };
  } catch (err) {
    if (err instanceof NativeAuthError) throw err;
    throw new NativeAuthError("google_token_invalid", 401);
  }
}

/**
 * Find (or link) the barber User for a verified provider profile, then mint a
 * session token. `provider` selects which id column to match/stamp. Precedence:
 * by provider id, else link an existing email account. LOGIN-ONLY - a profile
 * that matches no existing account is refused, never created: App Store
 * Guideline 3.1.1 forbids business-account registration inside the app, so
 * accounts are only created on the web. Do not add a create step back here;
 * the web OAuth flow (routes/auth.ts) is where sign-up lives.
 */
export async function signInWithProfile(
  provider: "apple" | "google",
  profile: NativeProfile,
): Promise<{
  token: string;
  tokenVersion: number;
  user: { id: string; email: string; name: string };
}> {
  // Concrete where/data per provider (Prisma's unique-where type rejects a
  // computed key, so branch explicitly rather than index by a variable).
  const linkData =
    provider === "apple" ? { appleId: profile.sub } : { googleId: profile.sub };

  // 1) Already linked to this provider id?
  let user =
    provider === "apple"
      ? await prisma.user.findUnique({ where: { appleId: profile.sub } })
      : await prisma.user.findUnique({ where: { googleId: profile.sub } });

  // 2) Else, an existing account with this email -> link it. Only when the
  // provider attests the email is VERIFIED: an unverified provider email must
  // never be able to claim (take over) the account that owns that address.
  if (!user && profile.email && profile.emailVerified) {
    const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
    if (byEmail) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: linkData,
      });
    }
  }

  // 3) No match -> refuse. One error for every miss (no email, unverified
  // email, or simply no such account) so the response can't be used to probe
  // which emails have ChairBack accounts. The app shows a friendly "no account
  // found" message for this code.
  if (!user) {
    throw new NativeAuthError("account_not_found", 403);
  }

  const token = mintSessionToken(user.id, user.tokenVersion);
  return {
    token,
    tokenVersion: user.tokenVersion,
    user: { id: user.id, email: user.email, name: user.name },
  };
}
