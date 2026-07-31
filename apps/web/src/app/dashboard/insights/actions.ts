"use server";

import { apiGet, apiSend } from "@/lib/api";
import type { GoalResponse, InsightsData, UtilizationData } from "./page";

/** Re-fetch insights for a non-default week range (mirrors trendsAction). */
export async function insightsAction(weeks: number): Promise<InsightsData | null> {
  const res = await apiGet<InsightsData>(`/api/insights?weeks=${weeks}`);
  return res.ok ? (res.data ?? null) : null;
}

/**
 * Chair utilization: open time vs sold time, grouped by weekday or service and
 * optionally narrowed to one barber. Fetched on demand as the barber changes
 * the card's controls, rather than widening the page's server payload.
 */
export async function utilizationAction(input: {
  weeks: number;
  by: "weekday" | "service";
  staffId?: string;
}): Promise<UtilizationData | null> {
  const params = new URLSearchParams({
    weeks: String(input.weeks),
    by: input.by,
    ...(input.staffId ? { staffId: input.staffId } : {}),
  });
  const res = await apiGet<UtilizationData>(`/api/insights/utilization?${params}`);
  return res.ok ? (res.data ?? null) : null;
}

/** Current goal + live progress (used to refresh after a save/clear). */
export async function goalAction(): Promise<GoalResponse | null> {
  const res = await apiGet<GoalResponse>("/api/insights/goal");
  return res.ok ? (res.data ?? null) : null;
}

/** Set or replace the shop's one goal. */
export async function saveGoalAction(input: {
  metric: "revenue" | "visits";
  period: "week" | "month";
  target: number;
}): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("PUT", "/api/insights/goal", input);
  return { ok: res.ok };
}

/** Clear the goal entirely. */
export async function clearGoalAction(): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("DELETE", "/api/insights/goal", {});
  return { ok: res.ok };
}
