"use server";

import { apiGet, apiSend } from "@/lib/api";
import type {
  Bucket,
  CustomRange,
  GoalMetric,
  GoalPeriod,
  GoalPlan,
  GoalResponse,
  InsightsData,
  PeriodKey,
  UtilizationData,
} from "./page";

/** Re-fetch the page's numbers for another period (mirrors trendsAction). */
export async function insightsAction(
  period: PeriodKey,
  bucket?: Bucket,
  range?: CustomRange,
): Promise<InsightsData | null> {
  const params = new URLSearchParams({
    period,
    ...(bucket ? { bucket } : {}),
    ...(period === "custom" && range ? { from: range.from, to: range.to } : {}),
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
  range?: CustomRange;
  by: "weekday" | "period" | "service";
  staffId?: string;
}): Promise<UtilizationData | null> {
  const params = new URLSearchParams({
    period: input.period,
    by: input.by,
    ...(input.bucket ? { bucket: input.bucket } : {}),
    ...(input.period === "custom" && input.range
      ? { from: input.range.from, to: input.range.to }
      : {}),
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
 * Set the target for ONE (metric, period). The other slots are untouched:
 * switching metric or period in the UI selects a different goal, it never
 * overwrites the one you were just looking at. `plan` rides along from the
 * planner (absent = keep the saved plan, null = clear it); `serviceId` makes
 * it a per-service quota instead.
 */
export async function saveGoalAction(input: {
  metric: GoalMetric;
  period: GoalPeriod;
  target: number;
  plan?: GoalPlan | null;
  serviceId?: string;
}): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("PUT", "/api/insights/goal", input);
  return { ok: res.ok };
}

/** The standing chair-time level: "run at N% booked". */
export async function saveChairTimeGoalAction(target: number): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("PUT", "/api/insights/goal", {
    metric: "chairTime",
    period: "overall",
    target,
  });
  return { ok: res.ok };
}

export async function clearChairTimeGoalAction(): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>(
    "DELETE",
    "/api/insights/goal?metric=chairTime",
    {},
  );
  return { ok: res.ok };
}

/** Clear ONE goal (or one service's quota), leaving the others in place. */
export async function clearGoalAction(input: {
  metric: GoalMetric;
  period: GoalPeriod;
  serviceId?: string;
}): Promise<{ ok: boolean }> {
  const params = new URLSearchParams({
    metric: input.metric,
    period: input.period,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
  });
  const res = await apiSend<{ ok: boolean }>(
    "DELETE",
    `/api/insights/goal?${params}`,
    {},
  );
  return { ok: res.ok };
}
