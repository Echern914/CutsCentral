"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { ADMIN_PASS_COOKIE_NAME } from "@chairback/config/constants";
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

//  Partner program (cash for people with a code; the API owns every rule)

async function partners(path: string, body?: unknown): Promise<AdminResult> {
  const res = await apiSend("POST", `/api/admin-portal/partners${path}`, body ?? {});
  revalidatePath("/admin");
  return { ok: res.ok, error: res.error };
}

export async function createPartnerAction(name: string, code: string, email: string): Promise<AdminResult> {
  return partners("", { name, code, email: email.trim() });
}
export async function setPartnerActiveAction(partnerId: string, active: boolean): Promise<AdminResult> {
  return partners(`/${encodeURIComponent(partnerId)}/active`, { active });
}
/**
 * `override` records a payment the API says is no longer covered (the partner
 * was paused, or rewards behind it were reversed) - for when the money has
 * already been sent by hand and the record has to say so.
 */
export async function markPartnerCashoutPaidAction(cashoutId: string, override = false): Promise<AdminResult> {
  return partners(`/cashouts/${encodeURIComponent(cashoutId)}/paid`, override ? { override: true } : {});
}
export async function declinePartnerCashoutAction(cashoutId: string): Promise<AdminResult> {
  return partners(`/cashouts/${encodeURIComponent(cashoutId)}/decline`);
}

//  Provider of the Month (routes/awardsAdmin.ts; the API owns the rules)

export interface GiveAwardInput {
  applicationId?: string;
  shopSlug?: string;
  month?: string;
  title?: string;
  winnerName?: string;
  specialty?: string;
  headline: string;
  description: string;
  statKeys?: string[];
}

export async function giveAwardAction(body: GiveAwardInput): Promise<AdminResult> {
  const res = await apiSend("POST", "/api/admin-portal/awards", body);
  revalidatePath("/admin");
  return { ok: res.ok, error: res.error };
}

export async function takeBackAwardAction(id: string, slug?: string | null): Promise<AdminResult> {
  const res = await apiSend("DELETE", `/api/admin-portal/awards/${encodeURIComponent(id)}`);
  revalidatePath("/admin");
  // Off their page now, not when its one-minute cache runs out.
  if (slug) {
    revalidatePath(`/s/${slug}`);
    revalidatePath(`/book/${slug}`);
  }
  return { ok: res.ok, error: res.error };
}

// --- Admin two-step (apps/api routes/adminPortal.stepUp.ts) ------------------

/**
 * The pass the API hands back when a code is accepted. Kept ONLY here, in an
 * httpOnly cookie on this origin - lib/api.ts forwards this origin's cookies
 * with every API call, so the portal's reads carry it from now on. Same-site
 * strict and 12 hours, matching the pass itself.
 */
const PASS_COOKIE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
  maxAge: 12 * 60 * 60,
} as const;

function keepPass(token: unknown): void {
  if (typeof token === "string" && token.length > 0) cookies().set(ADMIN_PASS_COOKIE_NAME, token, PASS_COOKIE);
}

export interface TwoStepResult {
  ok: boolean;
  error?: string;
  sentTo?: string;
}

export async function sendAdminEmailCodeAction(): Promise<TwoStepResult> {
  const res = await apiSend<{ sentTo?: string }>("POST", "/api/admin-portal/step-up/email/start");
  return res.ok ? { ok: true, sentTo: res.data?.sentTo } : { ok: false, error: res.error };
}

export async function verifyAdminEmailCodeAction(code: string): Promise<TwoStepResult> {
  const res = await apiSend<{ passToken?: string }>("POST", "/api/admin-portal/step-up/email/verify", { code });
  if (!res.ok) return { ok: false, error: res.error };
  keepPass(res.data?.passToken);
  revalidatePath("/admin");
  return { ok: true };
}

export async function verifyAdminTotpAction(code: string): Promise<TwoStepResult> {
  const res = await apiSend<{ passToken?: string }>("POST", "/api/admin-portal/step-up/totp", { code });
  if (!res.ok) return { ok: false, error: res.error };
  keepPass(res.data?.passToken);
  revalidatePath("/admin");
  return { ok: true };
}

export async function startAdminTotpSetupAction(): Promise<{ ok: boolean; secret?: string; qr?: string; error?: string }> {
  const res = await apiSend<{ secret: string; otpauthUri: string }>("POST", "/api/admin-portal/two-step/totp/setup");
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  const qr = await QRCode.toDataURL(res.data.otpauthUri, { margin: 1, width: 220 });
  return { ok: true, secret: res.data.secret, qr };
}

export async function confirmAdminTotpAction(code: string): Promise<TwoStepResult> {
  const res = await apiSend("POST", "/api/admin-portal/two-step/totp/confirm", { code });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/admin");
  return { ok: true };
}

//  Platform notices (the status banner on every barber's dashboard; the API
//  owns the rules - routes/adminPortal.notices.ts)

export interface NoticeWriteInput {
  title: string;
  body: string;
  severity: "info" | "maintenance" | "issue";
  /** ISO, already converted from the admin's own time zone. Omitted = now. */
  startsAt?: string;
  /** ISO, or null for "until resolved". */
  endsAt?: string | null;
  /** Send ONE push to shop owners' phones (the API refuses a second). */
  notifyPhones?: boolean;
}

export interface NoticeResult {
  ok: boolean;
  error?: string;
  /** What happened to "notify phones": sending | dry_run | already_sent | resolved | not_requested. */
  push?: string;
}

async function notices(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<NoticeResult> {
  const res = await apiSend<{ push?: string }>(method, `/api/admin-portal/notices${path}`, body);
  revalidatePath("/admin");
  return res.ok ? { ok: true, push: res.data?.push } : { ok: false, error: res.error ?? "failed" };
}

export async function createPlatformNoticeAction(input: NoticeWriteInput): Promise<NoticeResult> {
  return notices("POST", "", input);
}
export async function updatePlatformNoticeAction(id: string, input: Partial<NoticeWriteInput>): Promise<NoticeResult> {
  return notices("PATCH", `/${encodeURIComponent(id)}`, input);
}
export async function resolvePlatformNoticeAction(id: string): Promise<NoticeResult> {
  return notices("POST", `/${encodeURIComponent(id)}/resolve`);
}
export async function deletePlatformNoticeAction(id: string): Promise<NoticeResult> {
  return notices("DELETE", `/${encodeURIComponent(id)}`);
}
