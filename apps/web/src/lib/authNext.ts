import { cookies } from "next/headers";
import { LOGIN_NEXT_ALLOWLIST, safeNextPath } from "@chairback/config/nextPath";

/**
 * Carrying "where was this person going" across a provider round trip.
 *
 * A password sign-in can keep `next` in a hidden form field. Google and Apple
 * cannot: the browser leaves our origin entirely, bounces through the provider
 * and then through the API (a different origin, which is why the session comes
 * back as a handoff code at all), and arrives at a landing route with nothing
 * but that code. Any `next` we tried to thread through the provider's `state`
 * would have to survive two services that neither own nor validate it.
 *
 * So it waits here instead: a short-lived, httpOnly cookie on OUR origin, set
 * before we hand off and read by the landing route on the way back. It holds a
 * destination, never a credential, and it is validated against the allowlist
 * both when written and when read - a cookie is attacker-writable in ways a
 * server-side session is not, so it never gets the benefit of the doubt.
 */

export const AUTH_NEXT_COOKIE = "cb_auth_next";

/**
 * Cookies that mark a browser flow as one the NATIVE APP is waiting on, set by
 * /auth/mobile/start. `state` and `challenge` are the app's own PKCE material,
 * held only so the handoff code can be bound to them at the end - we never
 * learn the verifier, which is the whole point.
 */
export const MOBILE_STATE_COOKIE = "cb_mobile_state";
export const MOBILE_CHALLENGE_COOKIE = "cb_mobile_challenge";

/** Long enough for a slow OAuth round trip; short enough to be forgettable. */
export const AUTH_HANDOFF_COOKIE_MAX_AGE = 15 * 60;

export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // Lax, not Strict: the value has to survive a TOP-LEVEL GET navigation back
  // from the provider. Strict would drop it exactly when it is needed. It is
  // not a credential, so Lax carries no session risk here.
  sameSite: "lax" as const,
  path: "/",
  maxAge: AUTH_HANDOFF_COOKIE_MAX_AGE,
};

/** The stored destination, re-validated, or the caller's fallback. */
export function readAuthNext(fallback: string): string {
  const raw = cookies().get(AUTH_NEXT_COOKIE)?.value;
  return safeNextPath(raw, LOGIN_NEXT_ALLOWLIST, fallback);
}

/** True when the browser flow was started by the native app. */
export function isMobileHandoffFlow(): boolean {
  const jar = cookies();
  return Boolean(
    jar.get(MOBILE_STATE_COOKIE)?.value && jar.get(MOBILE_CHALLENGE_COOKIE)?.value,
  );
}

/**
 * The app's PKCE material, or null when this is an ordinary web flow. Read at
 * the very end, to mint the code that returns the barber to the app.
 */
export function readMobileHandoff(): { state: string; codeChallenge: string } | null {
  const jar = cookies();
  const state = jar.get(MOBILE_STATE_COOKIE)?.value;
  const codeChallenge = jar.get(MOBILE_CHALLENGE_COOKIE)?.value;
  if (!state || !codeChallenge) return null;
  return { state, codeChallenge };
}
