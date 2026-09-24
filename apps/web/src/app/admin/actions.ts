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

export interface TextingSwitchResult {
  ok: boolean;
  enabled?: boolean;
  updatedAt?: string;
  error?: string;
}

/**
 * Turn texting on or off for the WHOLE platform. The API answers 404 to
 * anyone who is not an admin; every API process follows within seconds.
 */
export async function setTextingAction(enabled: boolean): Promise<TextingSwitchResult> {
  const res = await apiSend<{ enabled: boolean; updatedAt: string }>(
    "POST",
    "/api/admin-portal/switches/sms",
    { enabled },
  );
  revalidatePath("/admin");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, enabled: res.data.enabled, updatedAt: res.data.updatedAt };
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

export async function retryAffiliateCreditAction(operationId: string): Promise<AdminResult> {
  return affiliate(`/credits/${operationId}/retry`);
}
export async function markAffiliateCreditAppliedAction(operationId: string, stripeBalanceTransactionId: string): Promise<AdminResult> {
  return affiliate(`/credits/${operationId}/mark-applied`, { stripeBalanceTransactionId });
}
export async function releaseAffiliateCreditAction(operationId: string): Promise<AdminResult> {
  return affiliate(`/credits/${operationId}/release`);
}
