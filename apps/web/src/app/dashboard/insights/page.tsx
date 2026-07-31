import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { DemoTour } from "@/components/tour/DemoTour";
import { InsightsClient } from "./InsightsClient";

export const metadata: Metadata = { title: "Insights" };

export interface InsightsData {
  weeks: { label: string; visits: number; revenue: number }[];
  services: { name: string; count: number; revenue: number }[];
  totals: {
    visits: number;
    revenue: number;
    avgTicket: number;
    uniqueClients: number;
    newClients: number;
    returningClients: number;
  };
  busiest: { weekday: string | null; counts: number[] };
  loyalty: { punchesEarned: number; punchesRedeemed: number; redemptions: number };
}

/**
 * Chair utilization: how much of the time the shop was OPEN actually sold.
 * `by=weekday` rows carry real capacity; `by=service` rows share one chair, so
 * their openMin is 0 and utilizationPct means "share of total open time".
 */
export interface UtilizationRow {
  key: string;
  label: string;
  openMin: number;
  bookedMin: number;
  bookings: number;
  days: number;
  utilizationPct: number | null;
}
export interface UtilizationData {
  by: "weekday" | "service";
  weeks: number;
  timezone: string;
  staff: { id: string; name: string }[];
  staffId: string | null;
  rows: UtilizationRow[];
  totals: {
    openMin: number;
    bookedMin: number;
    bookings: number;
    utilizationPct: number | null;
  };
  /** No weekly hours set at all — capacity is unknowable, show sold time only. */
  noSchedule: boolean;
  scheduleCaveat: boolean;
}

// Quota goal ("$4,000 this month" / "60 cuts this week") + live progress.
export interface GoalData {
  metric: "revenue" | "visits";
  period: "week" | "month";
  target: number;
}
export interface GoalProgress {
  periodStart: string; // YYYY-MM-DD (shop-local)
  periodEnd: string;
  totalDays: number;
  elapsedDays: number;
  daysLeft: number;
  actual: number;
  paceTarget: number; // straight-line target for the elapsed fraction
  delta: number; // actual - paceTarget (negative = behind pace)
  pct: number; // actual / target, capped at 1
  series: { day: number; cumulative: number | null }[]; // null = future day
}
export interface GoalResponse {
  goal: GoalData | null;
  progress: GoalProgress | null;
}

export default async function InsightsPage() {
  const [res, goalRes, me] = await Promise.all([
    apiGet<InsightsData>("/api/insights"),
    apiGet<GoalResponse>("/api/insights/goal"),
    getMe(),
  ]);
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your insights.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      {/* Barber-side guided tour. data-tour: keep in sync with
          packages/config/src/demoTour.ts */}
      <DemoTour tour="dashboard" route="insights" />
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Insights</h1>
        <p className="mt-1 text-sm text-muted">
          How your shop is doing: cuts per week, what people book most, and where
          the money comes from. Revenue counts priced visits only.
        </p>
      </header>
      <div data-tour="charts">
        <InsightsClient
          initial={res.data}
          initialGoal={goalRes.ok ? (goalRes.data ?? null) : null}
          rewardsEnabled={me.data?.rewardsEnabled ?? true}
        />
      </div>
    </main>
  );
}
