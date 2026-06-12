"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export interface PromoInput {
  kind: "PERCENT_OFF" | "AMOUNT_OFF" | "FREE_ADDON" | "EXTRA_PUNCHES";
  title: string;
  description?: string;
  code?: string;
  percentOff?: number;
  amountOff?: number;
  extraPunches?: number;
  startsAt?: string; // ISO
  endsAt?: string | null; // ISO
}

export async function createPromoAction(
  input: PromoInput,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", "/api/promos", input);
  revalidatePath("/dashboard/promotions");
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error:
      res.error === "limit_reached"
        ? "You've hit the promotion limit. Delete an old one first."
        : "Could not create the promotion. Check the fields.",
  };
}

export async function updatePromoAction(
  promoId: string,
  patch: Partial<Omit<PromoInput, "kind">> & { active?: boolean },
): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", `/api/promos/${promoId}`, patch);
  revalidatePath("/dashboard/promotions");
  return { ok: res.ok };
}

export async function deletePromoAction(promoId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("DELETE", `/api/promos/${promoId}`);
  revalidatePath("/dashboard/promotions");
  return { ok: res.ok };
}

export interface BlastSummary {
  considered: number;
  eligible: number;
  sent: number;
  failed: number;
  skippedCap: number;
  dryRun: boolean;
}

export async function blastPromoAction(
  promoId: string,
  audience: "all" | "atRisk",
  dryRun: boolean,
): Promise<BlastSummary | null> {
  const res = await apiSend<BlastSummary>("POST", `/api/promos/${promoId}/blast`, {
    audience,
    dryRun,
  });
  if (!dryRun) revalidatePath("/dashboard/promotions");
  return res.data;
}

export async function recordPromoUseAction(
  promoId: string,
  clientId: string,
): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", `/api/promos/${promoId}/use`, { clientId });
  revalidatePath("/dashboard/promotions");
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { ok: res.ok };
}
