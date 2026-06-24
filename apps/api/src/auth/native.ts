import { createRemoteJWKSet, jwtVerify } from "jose";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { mintSessionToken } from "./session.js";

const env = apiEnv();

/**
 * Native iOS sign-in: verify an identity token issued by Apple or Google to the
 * MOBILE app, then find-or-create the barber User and mint a session token the
 * app stores and sends as `Authorization: Bearer`. Mirrors the web Google
 * find-or-create (routes/auth.ts) - by provider id, else by email (link), else
 * create - so a barber has ONE account regardless of how they signed in.
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
    };
  } catch (err) {
    if (err instanceof NativeAuthError) throw err;
    throw new NativeAuthError("google_token_invalid", 401);
  }
}

/**
 * Find-or-create the barber User for a verified provider profile, then mint a
 * session token. `provider` selects which id column to match/stamp. Same
 * precedence as the web Google flow: by provider id, else link an existing email
 * account, else create. Returns the user + a fresh bearer token.
 */
export async function signInWithProfile(
  provider: "apple" | "google",
  profile: NativeProfile,
): Promise<{ token: string; user: { id: string; email: string; name: string } }> {
  // Concrete where/data per provider (Prisma's unique-where type rejects a
  // computed key, so branch explicitly rather than index by a variable).
  const linkData =
    provider === "apple" ? { appleId: profile.sub } : { googleId: profile.sub };

  // 1) Already linked to this provider id?
  let user =
    provider === "apple"
      ? await prisma.user.findUnique({ where: { appleId: profile.sub } })
      : await prisma.user.findUnique({ where: { googleId: profile.sub } });

  // 2) Else, an existing account with this email -> link it.
  if (!user && profile.email) {
    const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
    if (byEmail) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: linkData,
      });
    }
  }

  // 3) Else, create a new social-only account (no password).
  if (!user) {
    if (!profile.email) {
      // Apple can withhold the email on re-auth; without a prior link we can't
      // safely create or match an account.
      throw new NativeAuthError("no_email_to_create_account", 422);
    }
    user = await prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name?.trim() || profile.email.split("@")[0]!,
        ...linkData,
      },
    });
  }

  const token = mintSessionToken(user.id, user.tokenVersion);
  return { token, user: { id: user.id, email: user.email, name: user.name } };
}
