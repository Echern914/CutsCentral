"use server";

import { apiGet, apiSend } from "@/lib/api";

/**
 * The barber seat's own-clients actions. Everything lands on
 * /api/barber/clients, where "their clients" is derived server-side from the
 * seat's chair (req.shopStaffId) - these actions carry a search string and
 * client ids, never a staffId, and the phone comes back MASKED.
 */

export interface BarberClientRow {
  id: string;
  name: string;
  maskedPhone: string | null;
  lastSeen: string | null;
  visits: number;
  textable: boolean;
  reason: "no_phone" | "opted_out" | "no_consent" | null;
}

export interface BarberClientsData {
  chair: { staffId: string } | null;
  clients: BarberClientRow[];
  reason: string | null;
}

export async function getBarberClientsAction(q?: string): Promise<{
  ok: boolean;
  data?: BarberClientsData;
  error?: string;
}> {
  const path = q
    ? `/api/barber/clients?q=${encodeURIComponent(q)}`
    : "/api/barber/clients";
  const res = await apiGet<BarberClientsData>(path);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

export async function sendBarberRewardsLinkAction(
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/barber/clients/${clientId}/rewards-link`);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}
