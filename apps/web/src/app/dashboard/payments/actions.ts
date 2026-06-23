"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

type Result = { ok: boolean; error?: string };

/** Mint a Stripe onboarding link and return its URL for the client to open. */
export async function startConnectOnboardingAction(): Promise<{
  ok: boolean;
  url?: string;
  error?: string;
}> {
  const res = await apiSend<{ url: string }>("POST", "/api/payments/connect/onboard");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, url: res.data.url };
}

/** Save payment mode + cancellation policy. */
export async function savePaymentSettingsAction(input: {
  paymentsMode?: "off" | "ahead" | "hold";
  cancelWindowHours?: number;
  cancelFeeBps?: number;
}): Promise<Result> {
  const res = await apiSend("PATCH", "/api/payments/settings", input);
  if (res.ok) revalidatePath("/dashboard/payments");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

export interface PaymentStatus {
  connectAvailable: boolean;
  connect: {
    connected: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  };
  paymentsMode: "off" | "ahead" | "hold";
  platformFeeBps: number;
  cancelWindowHours: number;
  cancelFeeBps: number;
}

/** Read live Connect status + current settings (used by the page on load). */
export async function getPaymentStatusAction(): Promise<PaymentStatus | null> {
  const res = await apiGet<PaymentStatus>("/api/payments/status");
  return res.ok ? res.data : null;
}
