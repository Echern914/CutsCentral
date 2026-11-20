"use server";

import { apiGet } from "@/lib/api";

/**
 * A team member's own numbers. Whose they are is decided by the API from the
 * session (the chair this login is linked to): this carries a period and
 * nothing else, so it cannot ask for a colleague's.
 */

export type MyNumbersPeriod = "7d" | "30d" | "365d";

export interface MyNumbersData {
  chair: { id: string; name: string } | null;
  reason: string | null;
  period?: string;
  periodLabel?: string;
  windowStart?: string;
  windowEnd?: string;
  visits?: number;
  noShows?: number;
  revenueCents?: number;
  /** Null where this shop doesn't take tips and none were recorded. */
  tipsCents?: number | null;
}

export async function getMyNumbersAction(
  period: MyNumbersPeriod,
): Promise<{ ok: true; data: MyNumbersData } | { ok: false }> {
  const res = await apiGet<MyNumbersData>(`/api/barber/report?period=${encodeURIComponent(period)}`);
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false };
}
