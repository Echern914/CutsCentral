"use server";

import { apiSend } from "@/lib/api";
import { mintAppReturnUrl } from "@/lib/mobileReturn";

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

  const returnUrl = await mintAppReturnUrl("team_join");
  return { ok: true, ...(returnUrl ? { returnUrl } : {}) };
}
