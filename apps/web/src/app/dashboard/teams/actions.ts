"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";
import type { Sharing, TeamNumbers } from "@/lib/teamNumbers";
import type { RentHistory } from "@/lib/boothRent";
import type { ChairDay } from "@/lib/teamSchedule";
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
  patch: Partial<Sharing> & { shareSchedule?: boolean },
): Promise<{
  ok: boolean;
  error?: string;
  sharing?: Sharing;
  theySee?: TeamNumbers | null;
  shareSchedule?: boolean;
  scheduleToday?: ChairDay[] | null;
}> {
  const res = await apiSend<{
    sharing: Sharing;
    theySee: TeamNumbers | null;
    shareSchedule?: boolean;
    scheduleToday?: ChairDay[] | null;
  }>("PATCH", `/api/teams/${linkId}/sharing`, patch);
  revalidatePath("/dashboard/teams");
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  return {
    ok: true,
    sharing: res.data.sharing,
    theySee: res.data.theySee,
    shareSchedule: res.data.shareSchedule,
    scheduleToday: res.data.scheduleToday ?? null,
  };
}

/**
 * Take walk-ins who check in at this team's front desk (or stop). Returns
 * the CONFIRMED state and whether their own line is on to receive them.
 */
export async function setTeamWalkInsAction(
  linkId: string,
  take: boolean,
): Promise<{ ok: boolean; error?: string; walkIns?: { take: boolean; lineOn: boolean } }> {
  const res = await apiSend<{ walkIns: { take: boolean; lineOn: boolean } }>(
    "PATCH",
    `/api/teams/${linkId}/walk-ins`,
    { take },
  );
  revalidatePath("/dashboard/teams");
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  return { ok: true, walkIns: res.data.walkIns };
}

/** This business's booth rent with one team - the owner's own view. Read-only. */
export async function myRentHistoryAction(linkId: string): Promise<RentHistory | null> {
  const res = await apiGet<RentHistory>(`/api/teams/${linkId}/rent`);
  return res.ok ? (res.data ?? null) : null;
}

/** Leave a team, or withdraw a request that hasn't been approved. */
export async function leaveTeamAction(linkId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/teams/${linkId}/leave`);
  revalidatePath("/dashboard/teams");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Change what one MENTOR can see. Student only (the API refuses anyone else).
 * Returns the confirmed sharing and what the mentor now reads.
 */
export async function setMentorSharingAction(
  mentorshipId: string,
  patch: Partial<Sharing>,
): Promise<{ ok: boolean; error?: string; sharing?: Sharing; theySee?: TeamNumbers }> {
  const res = await apiSend<{ sharing: Sharing; theySee: TeamNumbers }>(
    "PATCH",
    `/api/teams/mentorships/${mentorshipId}/sharing`,
    patch,
  );
  revalidatePath("/dashboard/teams");
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  return { ok: true, sharing: res.data.sharing, theySee: res.data.theySee };
}

/** End a mentor pairing - as the student or as the mentor. */
export async function endMentorshipAction(mentorshipId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/teams/mentorships/${mentorshipId}/end`);
  revalidatePath("/dashboard/teams");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
