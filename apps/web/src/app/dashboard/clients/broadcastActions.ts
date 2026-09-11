"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export type BroadcastChannel = "email" | "push";
export type LoyaltyTierKey = "BRONZE" | "SILVER" | "GOLD";

export interface BroadcastPreview {
  reachable: number;
  considered: number;
  /** Email only: what's left in the monthly allowance. Null = unmetered. */
  emailsRemaining: number | null;
  skipped: { reason: string; count: number; label: string }[];
  /** Why it can't go out right now, already worded for the barber. */
  blocker: { kind: string; message: string } | null;
}

/** Who would receive this, and what it costs. Sends nothing. */
export async function previewBroadcastAction(input: {
  channel: BroadcastChannel;
  tiers: LoyaltyTierKey[];
}): Promise<{ ok: boolean; preview?: BroadcastPreview; error?: string }> {
  const res = await apiSend<BroadcastPreview>("POST", "/api/broadcasts/preview", input);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, preview: res.data };
}

/**
 * Write it and send it, in that order.
 *
 * Two calls rather than one because the draft is a real row: the send is
 * addressed to an id, which is what makes it resumable and what lets a second
 * press be refused rather than silently duplicated.
 */
export async function sendBroadcastAction(input: {
  channel: BroadcastChannel;
  tiers: LoyaltyTierKey[];
  subject: string;
  body: string;
}): Promise<{ ok: boolean; recipients?: number; error?: string }> {
  const created = await apiSend<{ id: string }>("POST", "/api/broadcasts", input);
  if (!created.ok || !created.data) return { ok: false, error: created.error ?? "failed" };
  const sent = await apiSend<{ recipients: number }>(
    "POST",
    `/api/broadcasts/${created.data.id}/send`,
  );
  if (!sent.ok) {
    // The API's refusal is already worded for a person - pass it through
    // rather than replacing it with something vaguer.
    return { ok: false, error: sent.message ?? sent.error ?? "failed" };
  }
  revalidatePath("/dashboard/clients");
  return { ok: true, recipients: sent.data?.recipients };
}
