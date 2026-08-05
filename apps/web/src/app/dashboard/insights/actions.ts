"use server";

import { apiGet, apiSend } from "@/lib/api";
import type {
  Bucket,
  GoalMetric,
  GoalPeriod,
  GoalResponse,
  InsightsData,
  PeriodKey,
  UtilizationData,
} from "./page";

/** Re-fetch the page's numbers for another period (mirrors trendsAction). */
export async function insightsAction(
  period: PeriodKey,
  bucket?: Bucket,
): Promise<InsightsData | null> {
  const params = new URLSearchParams({
    period,
    ...(bucket ? { bucket } : {}),
  });
  const res = await apiGet<InsightsData>(`/api/insights?${params}`);
  return res.ok ? (res.data ?? null) : null;
}

/**
 * Chair utilization: open time vs sold time, grouped by weekday, over time, or
 * by service, and optionally narrowed to one barber. Fetched on demand as the
 * barber changes the card's controls, rather than widening the page's payload.
 */
export async function utilizationAction(input: {
  period: PeriodKey;
  bucket?: Bucket;
  by: "weekday" | "period" | "service";
  staffId?: string;
}): Promise<UtilizationData | null> {
  const params = new URLSearchParams({
    period: input.period,
    by: input.by,
    ...(input.bucket ? { bucket: input.bucket } : {}),
    ...(input.staffId ? { staffId: input.staffId } : {}),
  });
  const res = await apiGet<UtilizationData>(`/api/insights/utilization?${params}`);
  return res.ok ? (res.data ?? null) : null;
}

/** All four goal slots + live progress (used to refresh after a save/clear). */
export async function goalAction(): Promise<GoalResponse | null> {
  const res = await apiGet<GoalResponse>("/api/insights/goal");
  return res.ok ? (res.data ?? null) : null;
}

/**
 * Set the target for ONE (metric, period). The other three slots are untouched:
 * switching metric or period in the UI selects a different goal, it never
 * overwrites the one you were just looking at.
 */
export async function saveGoalAction(input: {
  metric: GoalMetric;
  period: GoalPeriod;
  target: number;
}): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("PUT", "/api/insights/goal", input);
  return { ok: res.ok };
}

/** Clear ONE goal, leaving the others in place. */
export async function clearGoalAction(input: {
  metric: GoalMetric;
  period: GoalPeriod;
}): Promise<{ ok: boolean }> {
  const params = new URLSearchParams({ metric: input.metric, period: input.period });
  const res = await apiSend<{ ok: boolean }>(
    "DELETE",
    `/api/insights/goal?${params}`,
    {},
  );
  return { ok: res.ok };
}
