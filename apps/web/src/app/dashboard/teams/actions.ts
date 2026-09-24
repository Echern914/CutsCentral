"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";
import type { Sharing, TeamNumbers } from "@/lib/teamNumbers";
import type { MyTeamsData } from "./TeamsClient";

/** Re-read after any change - the server is the source of truth. */
export async function myTeamsAction(): Promise<MyTeamsData | null> {
  const res = await apiGet<MyTeamsData>("/api/teams");
  return res.ok ? (res.data ?? null) : null;
}

/**
 * Change what one team can see. Returns the CONFIRMED sharing and what the
 * team now sees, so the page shows the server's answer, never a guess.
 */
export async function setSharingAction(
  linkId: string,
  patch: Partial<Sharing>,
): Promise<{ ok: boolean; error?: string; sharing?: Sharing; theySee?: TeamNumbers | null }> {
  const res = await apiSend<{ sharing: Sharing; theySee: TeamNumbers | null }>(
    "PATCH",
    `/api/teams/${linkId}/sharing`,
    patch,
  );
  revalidatePath("/dashboard/teams");
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  return { ok: true, sharing: res.data.sharing, theySee: res.data.theySee };
}

/** Leave a team, or withdraw a request that hasn't been approved. */
export async function leaveTeamAction(linkId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/teams/${linkId}/leave`);
  revalidatePath("/dashboard/teams");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
