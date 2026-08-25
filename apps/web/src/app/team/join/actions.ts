"use server";

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

/**
 * Redeem a team invitation for the signed-in user, then - if the native app is
 * waiting on the other side of this browser - hand the session back to it.
 *
 * ORDER IS THE POINT. The seat is created FIRST and the return code is minted
 * second, so a barber whose app never reopens (dead battery, they closed the
 * sheet, they did this on a laptop) is still a member of the shop. Nothing
 * about their membership depends on the trip home succeeding.
 */
export async function joinTeamAction(
  token: string,
): Promise<{ ok: boolean; error?: string; returnUrl?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/team/join", { token });
  // "already_member" is success as far as the person is concerned: they have
  // the access the link promised. Anything else is a real failure.
  if (!res.ok && res.error !== "already_member") {
    return { ok: false, error: res.error };
  }

  const returnUrl = await mintAppReturnUrl();
  return { ok: true, ...(returnUrl ? { returnUrl } : {}) };
}

/**
 * Mint the one-time code that takes the barber back to the app, and return the
 * https callback to send the browser to. Null for an ordinary web visit.
 *
 * Best-effort by design: this runs AFTER the seat exists, so if the API is
 * having a bad second the honest outcome is "you joined, continue on the web",
 * not an error over a completed action.
 */
async function mintAppReturnUrl(): Promise<string | null> {
  const handoff = readMobileHandoff();
  if (!handoff) return null;

  const minted = await apiSend<{ code: string }>("POST", "/api/auth/mobile/code", {
    state: handoff.state,
    codeChallenge: handoff.codeChallenge,
    codeChallengeMethod: "S256",
    purpose: "team_join",
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
