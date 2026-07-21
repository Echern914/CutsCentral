"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ACTIVE_SHOP_COOKIE_NAME } from "@chairback/config/constants";
import { apiGet, apiSend } from "@/lib/api";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

const ACTIVE_SHOP_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

/**
 * Switch which owned shop the dashboard acts on (a manager with >1 shop). Writes
 * the active-shop cookie onto our origin so it's forwarded to the API, which
 * RE-VERIFIES ownership before honoring it — a stale/forged id simply falls back
 * to the owner's first shop, never another tenant. Set host-only AND domain-wide
 * (mirroring the session cookie) so API-origin navigations carry the selection.
 * The picker only ever offers shops from the user's own `me.shops`.
 */
export async function switchShopAction(shopId: string): Promise<void> {
  cookies().set(ACTIVE_SHOP_COOKIE_NAME, shopId, ACTIVE_SHOP_COOKIE_OPTIONS);
  const domain = sessionCookieDomain(headers().get("host"));
  if (domain) {
    cookies().set(ACTIVE_SHOP_COOKIE_NAME, shopId, {
      ...ACTIVE_SHOP_COOKIE_OPTIONS,
      domain,
    });
  }
  redirect("/dashboard");
}

export async function nudgeNowAction(clientId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/nudge/${clientId}`);
  revalidatePath("/dashboard");
  return { ok: res.ok };
}

export async function repairAcuitySyncAction(): Promise<{
  ok: boolean;
  subscribed?: number;
  message?: string;
}> {
  const res = await apiSend<{ ok: boolean; subscribed?: number; message?: string }>(
    "POST",
    "/api/acuity/oauth/repair",
  );
  revalidatePath("/dashboard");
  return res.data ?? { ok: res.ok };
}

export async function redeemAction(
  clientId: string,
  rewardId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/dashboard/redeem/${clientId}`, { rewardId });
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok, error: res.error };
}

export async function nudgeClientAction(
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/dashboard/nudge/${clientId}`);
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok, error: res.error };
}

export interface SweepSummary {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}

export async function sweepPreviewAction(): Promise<SweepSummary | null> {
  const res = await apiSend<SweepSummary>("POST", "/api/dashboard/sweep-preview");
  return res.data;
}

export async function runSweepAction(): Promise<{
  summary: SweepSummary | null;
  error?: string;
}> {
  const res = await apiSend<SweepSummary>("POST", "/api/dashboard/sweep");
  revalidatePath("/dashboard");
  return { summary: res.data, error: res.error };
}

export interface WinbackPreview {
  summary: SweepSummary;
  clients: { name: string; daysLapsed: number | null }[];
}

/** Dry-run the win-back ("Growth Agent") sweep: who WOULD be re-engaged, no send.
 *  Preview-only - real win-back sends happen on the daily cron, not from here. */
export async function winbackPreviewAction(): Promise<WinbackPreview | null> {
  const res = await apiSend<WinbackPreview>("POST", "/api/dashboard/winback-preview");
  return res.data;
}

export async function saveSettingsAction(
  _prev: { saved?: boolean; error?: string },
  formData: FormData,
): Promise<{ saved?: boolean; error?: string }> {
  const smsTemplate = String(formData.get("smsTemplate") ?? "").trim();
  const res = await apiSend("PATCH", "/api/shops/me", {
    name: String(formData.get("name") ?? "").trim() || undefined,
    // Send "" (not undefined) when blank so the API's clear-to-null branch fires
    // - otherwise JSON.stringify drops the key and a barber can never REMOVE a
    // booking link they previously set.
    bookingUrl: String(formData.get("bookingUrl") ?? "").trim(),
    nudgeBufferDays: Number(formData.get("nudgeBufferDays") ?? 7),
    dailySendCap: Number(formData.get("dailySendCap") ?? 50),
    rebookWindowDays: Number(formData.get("rebookWindowDays") ?? 14),
    smsTemplate: smsTemplate === "" ? null : smsTemplate,
    rewardsEnabled: formData.get("rewardsEnabled") === "on",
    loyaltyTextsEnabled: formData.get("loyaltyTextsEnabled") === "on",
  });
  revalidatePath("/dashboard");
  return res.ok ? { saved: true } : { error: "Could not save settings." };
}

/** One typeahead match: the client-list search returns a combined `name`. */
export interface ClientSearchResult {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * Live client search for the Clients-page typeahead. Hits the same
 * GET /api/dashboard/clients?q= endpoint (partial name OR phone, case-
 * insensitive), and returns the first few matches. NOTE: that endpoint returns
 * a combined `name` string (not firstName/lastName), so we read `name` here.
 */
export async function searchClientsByNameAction(
  q: string,
): Promise<{ ok: boolean; clients?: ClientSearchResult[]; error?: string }> {
  const trimmed = q.trim();
  if (trimmed.length < 2) return { ok: true, clients: [] };
  const res = await apiGet<{ clients: ClientSearchResult[] }>(
    `/api/dashboard/clients?q=${encodeURIComponent(trimmed)}`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, clients: res.data.clients.slice(0, 8) };
}

export async function addClientAction(
  _prev: { error?: string; ok?: boolean },
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const res = await apiSend<{ id: string }>("POST", "/api/dashboard/clients", {
    firstName: String(formData.get("firstName") ?? "").trim(),
    lastName: String(formData.get("lastName") ?? "").trim() || undefined,
    phone: String(formData.get("phone") ?? "").trim() || undefined,
    email: String(formData.get("email") ?? "").trim() || undefined,
    notes: String(formData.get("notes") ?? "").trim() || undefined,
    smsConsent: formData.get("smsConsent") === "on",
  });
  revalidatePath("/dashboard/clients");
  if (res.ok) return { ok: true };
  return {
    error:
      res.error === "invalid_phone"
        ? "That phone number isn't valid. Use a US number like (302) 555-0142."
        : "Could not add client. Check the fields.",
  };
}

export interface ImportClientRow {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export interface ImportResult {
  ok: boolean;
  created?: number;
  updated?: number;
  total?: number;
  skipped?: { row: number; reason: string }[];
  error?: string;
}

/**
 * Bulk-import a parsed client list (the file is parsed in the browser; we send
 * JSON rows). Consent defaults OFF on the server; attestConsentForAll only when
 * the barber explicitly affirms they have SMS consent for the whole batch.
 */
export async function importClientsAction(
  rows: ImportClientRow[],
  attestConsentForAll: boolean,
): Promise<ImportResult> {
  if (rows.length === 0) return { ok: false, error: "No rows to import." };
  const res = await apiSend<{
    created: number;
    updated: number;
    total: number;
    skipped: { row: number; reason: string }[];
  }>("POST", "/api/dashboard/clients/import", { rows, attestConsentForAll });
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  if (res.ok && res.data) {
    return { ok: true, ...res.data };
  }
  return { ok: false, error: "Import failed. Check the file and try again." };
}

export async function toggleOptOutAction(
  clientId: string,
  optedOut: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/opt`, { optedOut });
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  return { ok: res.ok, error: res.error };
}

export async function saveNotesAction(
  clientId: string,
  notes: string,
): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", `/api/dashboard/clients/${clientId}/notes`, { notes });
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
}

export async function bonusPunchAction(
  clientId: string,
  count: number,
  // Which punch card to credit; omitted/null = the default card.
  cardTypeId?: string | null,
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/bonus`, {
    count,
    ...(cardTypeId !== undefined && { cardTypeId }),
  });
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
}

export async function logVisitAction(
  clientId: string,
  serviceName?: string,
  // Card override; omitted = auto-route by service, null = force default card.
  cardTypeId?: string | null,
): Promise<{ ok: boolean; balance?: number }> {
  const res = await apiSend<{ ok: boolean; balance: number }>(
    "POST",
    `/api/dashboard/clients/${clientId}/visits`,
    {
      ...(serviceName ? { serviceName } : {}),
      ...(cardTypeId !== undefined && { cardTypeId }),
    },
  );
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, balance: res.data?.balance };
}

export async function reversePunchAction(
  clientId: string,
  entryId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend(
    "POST",
    `/api/dashboard/clients/${clientId}/ledger/${entryId}/reverse`,
  );
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error };
}

export async function adjustPunchAction(
  clientId: string,
  entryId: string,
  punches: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend(
    "POST",
    `/api/dashboard/clients/${clientId}/ledger/${entryId}/adjust`,
    { punches },
  );
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error };
}

export async function editVisitAction(
  clientId: string,
  visitId: string,
  fields: { when?: string; serviceName?: string | null },
): Promise<{ ok: boolean; error?: string; balance?: number }> {
  const res = await apiSend<{ ok: boolean; balance: number }>(
    "PATCH",
    `/api/dashboard/clients/${clientId}/visits/${visitId}`,
    fields,
  );
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error, balance: res.data?.balance };
}

export async function deleteVisitAction(
  clientId: string,
  visitId: string,
): Promise<{ ok: boolean; error?: string; balance?: number }> {
  const res = await apiSend<{ ok: boolean; balance: number }>(
    "DELETE",
    `/api/dashboard/clients/${clientId}/visits/${visitId}`,
  );
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error, balance: res.data?.balance };
}

export async function editClientAction(
  clientId: string,
  fields: { firstName?: string; lastName?: string | null; phone?: string | null; email?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("PATCH", `/api/dashboard/clients/${clientId}`, fields);
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  return { ok: res.ok, error: res.error };
}

export async function archiveClientAction(
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/archive`);
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error };
}

export async function unarchiveClientAction(
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/unarchive`);
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error };
}

/** Search the active client book by name/phone/email - powers the merge picker. */
export async function searchClientsAction(
  q: string,
): Promise<{ id: string; name: string; phone: string | null; email: string | null }[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const res = await apiGet<{
    clients: { id: string; name: string; phone: string | null; email: string | null }[];
  }>(`/api/dashboard/clients?q=${encodeURIComponent(trimmed)}`);
  return (res.data?.clients ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
  }));
}

/**
 * Merge a duplicate (loser) into this client (winner). The loser's history moves
 * here and the loser is archived. Revalidates both detail pages and the list.
 */
export async function mergeClientAction(
  winnerId: string,
  loserId: string,
): Promise<{ ok: boolean; error?: string; balance?: number }> {
  const res = await apiSend<{ ok: boolean; balance: number }>(
    "POST",
    `/api/dashboard/clients/${winnerId}/merge`,
    { loserId },
  );
  revalidatePath(`/dashboard/clients/${winnerId}`);
  revalidatePath(`/dashboard/clients/${loserId}`);
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard");
  return { ok: res.ok, error: res.error, balance: res.data?.balance };
}

export async function updateNameAction(
  _prev: { ok?: boolean; error?: string },
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const res = await apiSend("PATCH", "/api/auth/me", {
    name: String(formData.get("name") ?? "").trim(),
  });
  return res.ok ? { ok: true } : { error: "Could not update name." };
}

/**
 * Save (or clear, with "") the profile photo. Called straight from the avatar
 * picker on change - no form. Revalidates the account page + the dashboard
 * layout (the top-bar Account link shows the thumbnail).
 */
export async function updateAvatarAction(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("PATCH", "/api/auth/me", { avatarUrl: url });
  revalidatePath("/dashboard/account");
  revalidatePath("/dashboard");
  return res.ok ? { ok: true } : { ok: false, error: "Could not save your photo." };
}

export interface EmailChangeState {
  ok?: boolean;
  /** Echoed so the success copy can say which inbox to check. */
  sentTo?: string;
  error?: string;
}

/**
 * Start a login-email change: the API emails the NEW address a confirmation
 * link; nothing changes until it's clicked (see /confirm-email).
 */
export async function requestEmailChangeAction(
  _prev: EmailChangeState,
  formData: FormData,
): Promise<EmailChangeState> {
  const newEmail = String(formData.get("newEmail") ?? "").trim();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const res = await apiSend("POST", "/api/auth/change-email", {
    newEmail,
    ...(currentPassword ? { currentPassword } : {}),
  });
  if (res.ok) return { ok: true, sentTo: newEmail };
  return {
    error:
      res.error === "wrong_password"
        ? "Current password is incorrect."
        : res.error === "same_email"
          ? "That's already your login email."
          : res.error === "email_unavailable"
            ? "Email changes aren't available right now."
            : res.status === 400
              ? "Enter a valid email address."
              : "Could not start the email change. Try again.",
  };
}

export async function changePasswordAction(
  _prev: { ok?: boolean; error?: string },
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const res = await apiSend<{ ok: boolean }>("POST", "/api/auth/change-password", {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
  });
  if (res.ok) return { ok: true };
  return {
    error: res.error === "wrong_password" ? "Current password is incorrect." : "Could not change password.",
  };
}

export async function deleteAccountAction(
  _prev: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const res = await apiSend("DELETE", "/api/auth/me", {
    confirm: String(formData.get("confirm") ?? ""),
  });
  if (!res.ok) {
    return { error: "Confirmation didn't match. Type your account email exactly." };
  }
  // The account is gone and the API cleared the session cookie; /login is the
  // only truthful destination. (In the iOS app, barber.tsx intercepts this
  // /login navigation and hands off to the native sign-in screen.)
  redirect("/login");
}

export async function deleteShopAction(
  _prev: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const res = await apiSend("DELETE", "/api/shops/me", {
    confirm: String(formData.get("confirm") ?? ""),
  });
  if (!res.ok) {
    return { error: "Confirmation didn't match. Type your shop name exactly." };
  }
  // The account (and session) still exist - only the shop is gone. Onboarding
  // is the truthful destination; /login while still authenticated was a dead end.
  redirect("/onboarding");
}

// One month bucket from GET /api/dashboard/trends. Kept in sync with the API's
// series shape + the TrendPoint interface in TrendsChart.tsx.
interface TrendSeriesPoint {
  label: string;
  visits: number;
  nudges: number;
  newClients: number;
  paymentsSucceeded: number;
  rebookingsRecovered: number;
}

export async function trendsAction(months: number): Promise<TrendSeriesPoint[]> {
  const res = await apiGet<{ series: TrendSeriesPoint[] }>(
    `/api/dashboard/trends?months=${months}`,
  );
  return res.data?.series ?? [];
}

export async function bulkClientAction(
  action: "optOut" | "optIn" | "attestConsent" | "nudge",
  clientIds: string[],
): Promise<{
  ok: boolean;
  sent?: number;
  updated?: number;
  lockedByStop?: number;
  error?: string;
}> {
  const res = await apiSend<{
    ok: boolean;
    sent?: number;
    updated?: number;
    lockedByStop?: number;
  }>("POST", "/api/dashboard/clients/bulk", { action, clientIds });
  revalidatePath("/dashboard/clients");
  return res.data ?? { ok: res.ok, error: res.error };
}

export async function smsPreviewAction(template: string): Promise<string> {
  const res = await apiSend<{ preview: string }>("POST", "/api/shops/me/sms-preview", {
    template: template.trim() === "" ? null : template,
  });
  return res.data?.preview ?? "";
}
