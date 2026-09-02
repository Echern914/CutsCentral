"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export async function setCompAccessAction(
  shopId: string,
  compAccess: boolean,
): Promise<{ ok: boolean }> {
  const res = await apiSend(`POST` as const, `/api/admin-portal/shops/${shopId}/comp`, {
    compAccess,
  });
  revalidatePath("/admin");
  return { ok: res.ok };
}

//  Affiliate program (every call is one API transition; the API owns the rules)

type AdminResult = { ok: boolean; error?: string };

async function affiliate(path: string, body?: unknown): Promise<AdminResult> {
  const res = await apiSend("POST", `/api/admin-portal/affiliate${path}`, body ?? {});
  revalidatePath("/admin");
  return { ok: res.ok, error: res.error };
}

export async function approveAffiliateAction(applicationId: string, internalNote: string): Promise<AdminResult> {
  return affiliate(`/applications/${applicationId}/approve`, internalNote ? { internalNote } : {});
}
export async function rejectAffiliateAction(applicationId: string, decisionReason: string, internalNote: string): Promise<AdminResult> {
  return affiliate(`/applications/${applicationId}/reject`, { decisionReason, ...(internalNote ? { internalNote } : {}) });
}
export async function suspendAffiliateAction(accountId: string, suspensionReason: string, internalNote: string): Promise<AdminResult> {
  return affiliate(`/accounts/${accountId}/suspend`, { suspensionReason, ...(internalNote ? { internalNote } : {}) });
}
export async function reactivateAffiliateAction(accountId: string): Promise<AdminResult> {
  return affiliate(`/accounts/${accountId}/reactivate`);
}
export async function releaseAffiliateRewardAction(rewardId: string): Promise<AdminResult> {
  return affiliate(`/rewards/${rewardId}/release`);
}
export async function reverseAffiliateRewardAction(rewardId: string): Promise<AdminResult> {
  return affiliate(`/rewards/${rewardId}/reverse`);
}
export async function correctAttributionAction(attributionId: string, newCode: string, reason: string): Promise<AdminResult> {
  return affiliate(`/attributions/${attributionId}/correct`, { newCode, reason });
}
