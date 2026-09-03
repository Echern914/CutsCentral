"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

type Result = { ok: boolean; error?: string };

/**
 * Mint a one-time link into the barber's Stripe dashboard - the Express
 * dashboard for an account set up through ChairBack (there is NO stripe.com
 * login for those), or dashboard.stripe.com for a linked Standard account.
 */
export async function openStripeDashboardAction(): Promise<{
  ok: boolean;
  url?: string;
  error?: string;
}> {
  const res = await apiSend<{ url: string }>("POST", "/api/payments/connect/dashboard");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, url: res.data.url };
}

/**
 * Unlink the Stripe account. For a STANDARD account this also revokes ChairBack
 * at Stripe, so it disappears from the barber's own connected-apps list rather
 * than only appearing to be gone here.
 */
export async function disconnectStripeAction(): Promise<Result> {
  const res = await apiSend("POST", "/api/payments/connect/oauth/disconnect");
  if (res.ok) revalidatePath("/dashboard/payments");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

/** Save payment mode + cancellation policy. */
export async function savePaymentSettingsAction(input: {
  paymentsMode?: "off" | "ahead" | "deposit" | "hold";
  cancelWindowHours?: number;
  cancelFeeBps?: number;
  /** Deposit taken at booking, in CENTS (deposit mode only). */
  depositAmountCents?: number;
  /**
   * Whether shown prices already include a tip. DISPLAY ONLY - it moves no
   * money. null clears it back to saying nothing.
   */
  tipPolicy?: "included" | "not_included" | null;
}): Promise<Result> {
  const res = await apiSend("PATCH", "/api/payments/settings", input);
  if (res.ok) revalidatePath("/dashboard/payments");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

export interface PayDirectSettings {
  enabled: boolean;
  zelle: string | null;
  venmo: string | null;
  cashApp: string | null;
  note: string | null;
}

/** Save fee-free pay-direct handles (Zelle/Venmo/Cash App). No Stripe needed. */
export async function savePayDirectAction(input: {
  enabled?: boolean;
  zelle?: string | null;
  venmo?: string | null;
  cashApp?: string | null;
  note?: string | null;
}): Promise<Result> {
  const res = await apiSend("PATCH", "/api/payments/pay-direct", input);
  if (res.ok) revalidatePath("/dashboard/payments");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

export interface PaymentStatus {
  connectAvailable: boolean;
  /** Whether the "link the Stripe account I already have" door can be offered. */
  standardAvailable?: boolean;
  /** Which door the shop came through. Presentation only. */
  connectAccountType?: "express" | "standard" | null;
  /** Last 4 of the acct_, so a barber can confirm WHICH account this is. */
  connectAccountLast4?: string | null;
  connect: {
    connected: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  };
  paymentsMode: "off" | "ahead" | "deposit" | "hold";
  /** Null until the shop picks one; the UI suggests $20. */
  depositAmountCents: number | null;
  /** null = the barber has not said, and the booking page then says nothing. */
  tipPolicy: "included" | "not_included" | null;
  platformFeeBps: number;
  cancelWindowHours: number;
  cancelFeeBps: number;
  payDirect: PayDirectSettings;
}

/** Read live Connect status + current settings (used by the page on load). */
export async function getPaymentStatusAction(): Promise<PaymentStatus | null> {
  const res = await apiGet<PaymentStatus>("/api/payments/status");
  return res.ok ? res.data : null;
}
