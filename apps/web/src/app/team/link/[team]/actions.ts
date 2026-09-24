"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { apiSend } from "@/lib/api";
import { TEAM_LINK_COOKIE, clearTeamLinkCookie, teamKeyOk } from "@/lib/teamLinkCookie";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

/**
 * Ask to join a team with the signed-in person's own business. Asking grants
 * the shop nothing - the owner approves, and nothing is shared until the
 * barber chooses.
 */
export async function askToJoinAction(
  team: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!teamKeyOk(team)) return { ok: false, error: "team_not_found" };
  const res = await apiSend<{ ok: boolean }>("POST", "/api/teams/join", { team });
  if (!res.ok) return { ok: false, error: res.error };
  // The request exists now; onboarding has nothing left to finish.
  clearTeamLinkCookie();
  return { ok: true };
}

/** No business yet: remember the team, then set one up. */
export async function startBusinessAction(formData: FormData): Promise<void> {
  const team = formData.get("team");
  if (teamKeyOk(team)) {
    cookies().set(TEAM_LINK_COOKIE, team, { ...COOKIE_OPTIONS, maxAge: 60 * 60 * 24 });
  }
  redirect("/onboarding");
}
