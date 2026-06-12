"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

/**
 * Loyalty designer mutations. Every action revalidates the rewards page so the
 * server-fetched config re-renders with the change.
 */

export interface RewardInput {
  name: string;
  description?: string;
  emoji?: string;
  punchCost: number;
}

export async function createRewardAction(
  input: RewardInput,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", "/api/loyalty/rewards", input);
  revalidatePath("/dashboard/rewards");
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error:
      res.error === "limit_reached"
        ? "You've hit the reward limit. Remove one to add another."
        : "Could not add the reward. Check the fields.",
  };
}

export async function updateRewardAction(
  rewardId: string,
  patch: Partial<RewardInput> & { active?: boolean; sortOrder?: number },
): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", `/api/loyalty/rewards/${rewardId}`, patch);
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export async function deleteRewardAction(rewardId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("DELETE", `/api/loyalty/rewards/${rewardId}`);
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export interface RuleInput {
  serviceMatch: string;
  punches: number;
}

export async function createRuleAction(
  input: RuleInput,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", "/api/loyalty/rules", input);
  revalidatePath("/dashboard/rewards");
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error:
      res.error === "limit_reached"
        ? "You've hit the rule limit. Remove one to add another."
        : "Could not add the rule. Check the fields.",
  };
}

export async function updateRuleAction(
  ruleId: string,
  patch: Partial<RuleInput> & { active?: boolean },
): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", `/api/loyalty/rules/${ruleId}`, patch);
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export async function deleteRuleAction(ruleId: string): Promise<{ ok: boolean }> {
  const res = await apiSend("DELETE", `/api/loyalty/rules/${ruleId}`);
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export async function saveEarnRateAction(
  punchesPerVisit: number,
): Promise<{ ok: boolean }> {
  const res = await apiSend("PATCH", "/api/loyalty/settings", { punchesPerVisit });
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export async function reorderRewardsAction(ids: string[]): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", "/api/loyalty/rewards/reorder", { ids });
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}

export async function reorderRulesAction(ids: string[]): Promise<{ ok: boolean }> {
  const res = await apiSend("POST", "/api/loyalty/rules/reorder", { ids });
  revalidatePath("/dashboard/rewards");
  return { ok: res.ok };
}
