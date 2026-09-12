"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

export type BroadcastChannel = "email" | "push";
export type LoyaltyTierKey = "BRONZE" | "SILVER" | "GOLD";

export interface BroadcastPreview {
  reachable: number;
  considered: number;
  /** Email only: what's left in the monthly allowance. Null = unmetered. */
  emailsRemaining: number | null;
  /** What fits on THIS channel - a push is not an email with a longer wait. */
  limits: { subject: number; body: number };
  skipped: { reason: string; count: number; label: string }[];
  /** Why it can't go out right now, already worded for the barber. */
  blocker: { kind: string; message: string } | null;
}

export interface BroadcastRow {
  id: string;
  channel: BroadcastChannel;
  subject: string | null;
  body: string;
  status: "DRAFT" | "QUEUED" | "SENDING" | "SENT" | "PARTIAL" | "FAILED";
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  /** Still to go. Non-zero only while it is actually moving. */
  pendingCount: number;
  queuedAt: string | null;
  sentAt: string | null;
  createdAt: string;
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
 * What this shop has sent, with LIVE progress on anything still moving.
 *
 * Polled while a blast is in flight. The counters on a finished broadcast are
 * frozen and final; the ones on a moving broadcast are derived from its
 * recipient rows, so the line the barber is watching actually advances.
 */
export async function listBroadcastsAction(): Promise<{
  ok: boolean;
  broadcasts?: BroadcastRow[];
  error?: string;
}> {
  const res = await apiGet<{ broadcasts: BroadcastRow[] }>("/api/broadcasts");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, broadcasts: res.data.broadcasts };
}

/**
 * Write it and commit to it, in that order.
 *
 * 🔴 THE SECOND CALL DOES NOT DELIVER ANYTHING. It freezes the audience,
 * reserves the month's allowance and answers QUEUED; a worker sends the
 * messages afterwards. So `recipients` here is a row count rather than a
 * forecast, and it is the honest thing to put in front of the barber.
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
  if (!created.ok || !created.data) {
    // The length rules are worded for a person ("a notification gets cut off on
    // the phone"); passing them through beats replacing them with "invalid".
    return { ok: false, error: created.message ?? created.error ?? "failed" };
  }
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
