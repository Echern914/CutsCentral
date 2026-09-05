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
  /** Narrow booked time to one service or one group (mutually exclusive). */
  serviceId?: string;
  groupId?: string;
}): Promise<UtilizationData | null> {
  const params = new URLSearchParams({
    period: input.period,
    by: input.by,
    ...(input.bucket ? { bucket: input.bucket } : {}),
    ...(input.period === "custom" && input.range
      ? { from: input.range.from, to: input.range.to }
      : {}),
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
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

//  The yearly performance report

/**
 * A number the report cannot honestly print, and why. Rendered as an explicit
 * "not tracked" line - a missing row would read as a zero, and a zero reads as
 * a fact.
 */
export interface UnavailableMetric {
  key: string;
  label: string;
  reason: string;
}

export interface YearlyReportData {
  year: number;
  yearToDate: boolean;
  periodLabel: string;
  timezone: string;
  currency: string;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  shopName: string;
  staffId: string | null;
  subjectName: string;
  scope: "shop" | "staff";
  /** The shop's own word for a provider ("barber", "stylist", "nail tech"). */
  providerNoun: string;
  syncedExcluded: boolean;
  totals: {
    appointments: number;
    noShows: number;
    cancellations: number;
    booked: number;
    noShowRateBp: number | null;
    cancellationRateBp: number | null;
    uniqueClients: number;
    newClients: number;
    returningClients: number;
    returnRateBp: number | null;
    walkIns: number;
    revenueCents: number;
    avgMonthlyRevenueCents: number;
    avgTicketCents: number | null;
    pricedCount: number;
    unpricedCount: number;
    settledThroughChairbackCents: number;
    collectedInPersonCents: number;
  };
  busiest: {
    month: string | null;
    monthKey: string | null;
    weekday: string | null;
    weekdayCounts: number[];
  };
  months: {
    key: string;
    label: string;
    fullLabel: string;
    appointments: number;
    revenueCents: number;
    complete: boolean;
  }[];
  services: { name: string; count: number; revenueCents: number }[];
  unavailable: UnavailableMetric[];
}

export interface YearlyReportOptions {
  years: number[];
  currentYear: number;
  timezone: string;
  canReportShop: boolean;
  defaultSubject: string | null;
  shopName: string;
  subjects: { id: string; name: string; active: boolean }[];
}

/**
 * Which years and which barbers this session may ask for.
 *
 * Read from the API rather than assembled here, so the picker can never offer
 * an option the API would refuse - a barber sees exactly one name (his own) and
 * no "whole shop" choice, because the API filtered the list in its QUERY.
 */
export async function yearlyReportOptionsAction(): Promise<YearlyReportOptions | null> {
  const res = await apiGet<YearlyReportOptions>("/api/yearly-report/options");
  return res.ok ? (res.data ?? null) : null;
}

/**
 * The report itself. The SAME payload the PDF is rendered from, so the preview
 * on screen and the printed page cannot show different numbers.
 */
export async function yearlyReportAction(input: {
  year: number;
  subject: string;
}): Promise<{ report: YearlyReportData; filename: string } | { error: string } | null> {
  const params = new URLSearchParams({
    year: String(input.year),
    subject: input.subject,
  });
  const res = await apiGet<{ report: YearlyReportData; filename: string }>(
    `/api/yearly-report?${params}`,
  );
  if (res.ok && res.data) return res.data;
  // 403 is "not your report" and 404 "no such barber here" - two different
  // sentences for the reader, so the status is not flattened into null.
  if (res.status === 403) return { error: "forbidden" };
  if (res.status === 404) return { error: "not_found" };
  return null;
}
