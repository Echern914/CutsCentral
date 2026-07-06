"use server";

import { apiGet } from "@/lib/api";
import type { InsightsData } from "./page";

/** Re-fetch insights for a non-default week range (mirrors trendsAction). */
export async function insightsAction(weeks: number): Promise<InsightsData | null> {
  const res = await apiGet<InsightsData>(`/api/insights?weeks=${weeks}`);
  return res.ok ? (res.data ?? null) : null;
}
