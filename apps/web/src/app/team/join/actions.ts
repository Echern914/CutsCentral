"use server";

import { apiSend } from "@/lib/api";

/** Redeem a team invitation for the signed-in user. */
export async function joinTeamAction(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/team/join", { token });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
