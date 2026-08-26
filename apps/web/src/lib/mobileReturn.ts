import { cookies } from "next/headers";
import { MOBILE_APP } from "@chairback/config/constants";
import { apiSend } from "@/lib/api";
import {
  AUTH_COOKIE_OPTIONS,
  AUTH_NEXT_COOKIE,
  MOBILE_CHALLENGE_COOKIE,
  MOBILE_STATE_COOKIE,
  readMobileHandoff,
} from "@/lib/authNext";

/** Which browser flow is handing the session back. See MobileCodePurpose. */
export type MobileReturnPurpose = "team_join" | "new_shop";

/**
 * Mint the one-time code that takes someone back to the native app, and return
 * the https callback to send the browser to. Null for an ordinary web visit.
 *
 * Shared by the two flows that can END in the app — an invited barber accepting
 * their invitation, and a new owner finishing shop creation. One implementation
 * on purpose: this spends the hand-off cookies, and two copies of "when is the
 * flow over" is how one of them ends up leaving a live pair behind that bounces
 * a later, unrelated sign-in into the app.
 *
 * BEST-EFFORT BY DESIGN. It runs AFTER the thing the person came to do has
 * already succeeded, so when the API is having a bad second the honest outcome
 * is "you're done, carry on here on the web" — never an error over completed
 * work, and never a rollback of it.
 */
export async function mintAppReturnUrl(
  purpose: MobileReturnPurpose,
): Promise<string | null> {
  const handoff = readMobileHandoff();
  if (!handoff) return null;

  const minted = await apiSend<{ code: string }>("POST", "/api/auth/mobile/code", {
    state: handoff.state,
    codeChallenge: handoff.codeChallenge,
    codeChallengeMethod: "S256",
    purpose,
  });

  // Spend the flow either way: these cookies mark "an app is waiting", and a
  // stale pair would try to bounce a later, unrelated sign-in into the app.
  const jar = cookies();
  for (const name of [MOBILE_STATE_COOKIE, MOBILE_CHALLENGE_COOKIE, AUTH_NEXT_COOKIE]) {
    jar.set(name, "", { ...AUTH_COOKIE_OPTIONS, maxAge: 0 });
  }

  if (!minted.ok || !minted.data?.code) return null;
  return (
    `${MOBILE_APP.authCallbackPath}?code=${encodeURIComponent(minted.data.code)}` +
    `&state=${encodeURIComponent(handoff.state)}`
  );
}
