"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

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

export async function smsPreviewAction(template: string): Promise<string> {
  const res = await apiSend<{ preview: string }>("POST", "/api/shops/me/sms-preview", {
    template: template.trim() === "" ? null : template,
  });
  return res.data?.preview ?? "";
}
