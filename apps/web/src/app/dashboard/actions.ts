"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiGet, apiSend } from "@/lib/api";

export async function nudgeNowAction(clientId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/nudge/${clientId}`);
  revalidatePath("/dashboard");
  return { ok: res.ok };
}

export async function redeemAction(clientId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/dashboard/redeem/${clientId}`);
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
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
    rewardThreshold: Number(formData.get("rewardThreshold") ?? 10),
    rewardLabel: String(formData.get("rewardLabel") ?? "Free Cut"),
    nudgeBufferDays: Number(formData.get("nudgeBufferDays") ?? 7),
    dailySendCap: Number(formData.get("dailySendCap") ?? 50),
    rebookWindowDays: Number(formData.get("rebookWindowDays") ?? 14),
    smsTemplate: smsTemplate === "" ? null : smsTemplate,
    logoUrl: String(formData.get("logoUrl") ?? "").trim(),
    accentColor: String(formData.get("accentColor") ?? "").trim(),
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
  });
  revalidatePath("/dashboard/clients");
  return res.ok ? { ok: true } : { error: "Could not add client. Check the fields." };
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
  redirect("/login");
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
  action: "optOut" | "optIn" | "nudge",
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

export async function smsPreviewAction(template: string): Promise<string> {
  const res = await apiSend<{ preview: string }>("POST", "/api/shops/me/sms-preview", {
    template: template.trim() === "" ? null : template,
  });
  return res.data?.preview ?? "";
}
