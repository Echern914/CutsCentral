"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiGet, apiSend } from "@/lib/api";

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

export async function nudgeClientAction(clientId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/nudge/${clientId}`);
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
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

export async function runSweepAction(): Promise<SweepSummary | null> {
  const res = await apiSend<SweepSummary>("POST", "/api/dashboard/sweep");
  revalidatePath("/dashboard");
  return res.data;
}

export async function saveSettingsAction(
  _prev: { saved?: boolean; error?: string },
  formData: FormData,
): Promise<{ saved?: boolean; error?: string }> {
  const smsTemplate = String(formData.get("smsTemplate") ?? "").trim();
  const res = await apiSend("PATCH", "/api/shops/me", {
    name: String(formData.get("name") ?? "").trim() || undefined,
    bookingUrl: String(formData.get("bookingUrl") ?? "").trim() || undefined,
    nudgeBufferDays: Number(formData.get("nudgeBufferDays") ?? 7),
    dailySendCap: Number(formData.get("dailySendCap") ?? 50),
    rebookWindowDays: Number(formData.get("rebookWindowDays") ?? 14),
    smsTemplate: smsTemplate === "" ? null : smsTemplate,
  });
  revalidatePath("/dashboard");
  return res.ok ? { saved: true } : { error: "Could not save settings." };
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

export async function toggleOptOutAction(
  clientId: string,
  optedOut: boolean,
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/opt`, { optedOut });
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
  return { ok: res.ok };
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
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/clients/${clientId}/bonus`, { count });
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
}

export async function logVisitAction(
  clientId: string,
  serviceName?: string,
): Promise<{ ok: boolean; balance?: number }> {
  const res = await apiSend<{ ok: boolean; balance: number }>(
    "POST",
    `/api/dashboard/clients/${clientId}/visits`,
    serviceName ? { serviceName } : {},
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

export async function updateNameAction(
  _prev: { ok?: boolean; error?: string },
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const res = await apiSend("PATCH", "/api/auth/me", {
    name: String(formData.get("name") ?? "").trim(),
  });
  return res.ok ? { ok: true } : { error: "Could not update name." };
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

export async function trendsAction(
  months: number,
): Promise<{ label: string; visits: number; nudges: number }[]> {
  const res = await apiGet<{ series: { label: string; visits: number; nudges: number }[] }>(
    `/api/dashboard/trends?months=${months}`,
  );
  return res.data?.series ?? [];
}

export async function bulkClientAction(
  action: "optOut" | "optIn" | "attestConsent" | "nudge",
  clientIds: string[],
): Promise<{ ok: boolean; sent?: number; updated?: number }> {
  const res = await apiSend<{ ok: boolean; sent?: number; updated?: number }>(
    "POST",
    "/api/dashboard/clients/bulk",
    { action, clientIds },
  );
  revalidatePath("/dashboard/clients");
  return res.data ?? { ok: res.ok };
}

/**
 * Stamp the first-run welcome tour as seen so it stops auto-opening. Fire once
 * when the barber finishes or skips the carousel; the API is idempotent (only
 * the still-null row gets stamped), so replays from the account card are free.
 */
export async function markWelcomeSeenAction(): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", "/api/auth/welcome-seen");
  return { ok: res.ok };
}

export async function smsPreviewAction(template: string): Promise<string> {
  const res = await apiSend<{ preview: string }>("POST", "/api/shops/me/sms-preview", {
    template: template.trim() === "" ? null : template,
  });
  return res.data?.preview ?? "";
}
