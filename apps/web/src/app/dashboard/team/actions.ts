"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";
import type { TeamData } from "./page";
import type { TeamLinksData } from "./IndependentTeam";
import type { RentHistory, RentPeriod, RentSummary } from "@/lib/boothRent";

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

/** Give a member a brand-new chair of their own, named after them, and link it. */
export async function createChairForMemberAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/team/members/${id}/staff`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function removeMemberAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("DELETE", `/api/team/members/${id}`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---- Independent businesses on the team (TeamLink) ----

/** Re-read the team link card after any change (owner only). */
export async function teamLinksAction(): Promise<TeamLinksData | null> {
  const res = await apiGet<TeamLinksData>("/api/team/links");
  return res.ok ? (res.data ?? null) : null;
}

export async function approveLinkAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/team/links/${id}/approve`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Decline a request, or take someone off the team. */
export async function endLinkAction(id: string): Promise<TeamActionResult> {
  const res = await apiSend<{ ok: boolean }>("POST", `/api/team/links/${id}/end`);
  revalidatePath("/dashboard/team");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---- Booth rent. Every write returns the server's summary afterwards. ----

export interface RentResult {
  ok: boolean;
  error?: string;
  rent?: RentSummary;
}

/**
 * Start, change or stop (amountCents null) a member's booth rent. `startsOn`
 * only counts when no rent is in effect; a change waits for the next period.
 */
export async function setRentAction(
  linkId: string,
  input: { amountCents: number | null; period?: RentPeriod; startsOn?: string },
): Promise<RentResult> {
  const res = await apiSend<{ rent: RentSummary }>("PUT", `/api/team/links/${linkId}/rent`, input);
  return res.ok && res.data ? { ok: true, rent: res.data.rent } : { ok: false, error: res.error };
}

/** Record rent received. `clientRef` makes a retried submit record one payment. */
export async function recordRentPaymentAction(
  linkId: string,
  input: { amountCents: number; date: string; method: string; note?: string; clientRef: string },
): Promise<RentResult> {
  const res = await apiSend<{ rent: RentSummary }>("POST", `/api/team/links/${linkId}/rent/payments`, input);
  return res.ok && res.data ? { ok: true, rent: res.data.rent } : { ok: false, error: res.error };
}

/** Void a payment recorded by mistake: it stays in the history, marked, and stops counting. */
export async function voidRentPaymentAction(linkId: string, paymentId: string): Promise<RentResult> {
  const res = await apiSend<{ rent: RentSummary }>(
    "POST",
    `/api/team/links/${linkId}/rent/payments/${paymentId}/void`,
  );
  return res.ok && res.data ? { ok: true, rent: res.data.rent } : { ok: false, error: res.error };
}

/** Void the latest rent entry (a wrong amount or start date), kept in the history. */
export async function voidRentRateAction(linkId: string, rateId: string): Promise<RentResult> {
  const res = await apiSend<{ rent: RentSummary }>("POST", `/api/team/links/${linkId}/rent/rates/${rateId}/void`);
  return res.ok && res.data ? { ok: true, rent: res.data.rent } : { ok: false, error: res.error };
}

/** One member's rent: the summary, every payment and every rent entry. */
export async function rentHistoryAction(linkId: string): Promise<RentHistory | null> {
  const res = await apiGet<RentHistory>(`/api/team/links/${linkId}/rent`);
  return res.ok ? (res.data ?? null) : null;
}
