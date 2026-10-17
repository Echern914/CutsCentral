"use server";

import { revalidatePath } from "next/cache";
import type { AwardStat } from "@chairback/config/providerAward";
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
