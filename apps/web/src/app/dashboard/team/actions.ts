"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";
import type { TeamData } from "./page";

/** Re-read the roster after any change (server is the source of truth). */
export async function teamAction(): Promise<TeamData | null> {
  const res = await apiGet<TeamData>("/api/team");
  return res.ok ? (res.data ?? null) : null;
}

export interface TeamActionResult {
  ok: boolean;
  /** Machine code from the API, so the UI can explain the specific refusal. */
  error?: string;
}

export async function inviteMemberAction(input: {
  email: string;
  role: "MANAGER" | "BARBER";
  staffId?: string;
}): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/team/invites", {
    email: input.email,
    role: input.role,
    ...(input.staffId ? { staffId: input.staffId } : {}),
  });
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function revokeInviteAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("DELETE", `/api/team/invites/${id}`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function updateMemberAction(
  id: string,
  input: { role?: "MANAGER" | "BARBER"; staffId?: string | null },
): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("PATCH", `/api/team/members/${id}`, input);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function removeMemberAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("DELETE", `/api/team/members/${id}`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
