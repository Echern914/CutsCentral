"use server";

import { revalidatePath } from "next/cache";
import type { AwardStat, PublicAward } from "@chairback/config/providerAward";
import { apiSend } from "@/lib/api";
import { apiAnswered } from "@/lib/apiAnswered";

/** GET /api/awards/me (routes/awards.ts). */
export interface AwardMe {
  month: string;
  monthLabel: string;
  stats: AwardStat[];
  application: {
    pitch: string;
    credentials: string | null;
    stats: AwardStat[];
    status: "SUBMITTED" | "WON" | "NOT_CHOSEN";
    updatedAt: string;
  } | null;
  won: { month: string; monthLabel: string; title: string; headline: string; description: string }[];
  /** Chosen, waiting for their OK - the card exactly as it will show. */
  pending?: (PublicAward & { id: string }) | null;
}

export type ApplyResult =
  | { ok: true; application: NonNullable<AwardMe["application"]> }
  | { ok: false; error: "already_decided" | "invalid" | "failed" | "no_answer" };

export async function applyForAwardAction(input: {
  pitch: string;
  credentials: string;
  statKeys: string[];
}): Promise<ApplyResult> {
  const res = await apiSend<{ application: NonNullable<AwardMe["application"]> }>("POST", "/api/awards/apply", {
    pitch: input.pitch,
    ...(input.credentials.trim() ? { credentials: input.credentials } : {}),
    statKeys: input.statKeys,
  });
  revalidatePath("/dashboard/award");
  if (res.ok && res.data) return { ok: true, application: res.data.application };
  if (!apiAnswered(res.status)) return { ok: false, error: "no_answer" };
  if (res.status === 409) return { ok: false, error: "already_decided" };
  if (res.status === 400) return { ok: false, error: "invalid" };
  return { ok: false, error: "failed" };
}

export type DecideResult = { ok: true; status: "APPROVED" | "DECLINED" } | { ok: false; error: "already_decided" | "failed" | "no_answer" };

/** Approve (or decline) exactly what ChairBack wrote. Nothing posts before. */
export async function decideAwardAction(id: string, decision: "approve" | "decline"): Promise<DecideResult> {
  const res = await apiSend<{ status: "APPROVED" | "DECLINED"; slug?: string | null }>(
    "POST",
    `/api/awards/${encodeURIComponent(id)}/${decision}`,
  );
  revalidatePath("/dashboard/award");
  // Her page shows it NOW, not when its one-minute cache runs out.
  if (res.data?.slug) {
    revalidatePath(`/s/${res.data.slug}`);
    revalidatePath(`/book/${res.data.slug}`);
  }
  if (res.ok && res.data) return { ok: true, status: res.data.status };
  if (!apiAnswered(res.status)) return { ok: false, error: "no_answer" };
  if (res.status === 409) return { ok: false, error: "already_decided" };
  return { ok: false, error: "failed" };
}
