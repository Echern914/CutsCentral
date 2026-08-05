import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { DemoTour } from "@/components/tour/DemoTour";
import { InsightsClient } from "./InsightsClient";

export const metadata: Metadata = { title: "Insights" };

/** Keys of the page's one period control (mirrors PERIODS in the API engine). */
export type PeriodKey = "7d" | "30d" | "90d" | "180d" | "365d";
/** Bar sizes a period can be viewed at (mirrors BUCKET_COUNTS in the engine). */
export type Bucket = "day" | "week" | "month";

// Module-local, NOT exported: a Next page module may only export `default`,
// `metadata` and friends, so a runtime export here fails the build's type check.
// (Type-only exports above are erased and stay fine.) The API applies the same
// default independently, so this only picks the server-rendered first paint.
const DEFAULT_PERIOD: PeriodKey = "30d";

/**
 * Every Insights response echoes the window it measured and what one bar of it
 * represents, so no label on the page can drift from the numbers under it.
 */
export interface PeriodMeta {
  period: PeriodKey;
  periodLabel: string; // "Last 30 days"
  bucket: Bucket;
  bucketNoun: string; // "day" | "week" | "month" — drives the chart's title
  /** Which bar sizes THIS period offers — drives the Day/Week/Month pills. */
  bucketOptions: Bucket[];
  windowStart: string; // YYYY-MM-DD, shop-local
  windowEnd: string;
  periods: { key: PeriodKey; label: string }[];
}

export interface InsightsData extends PeriodMeta {
  buckets: {
    key: string;
    label: string; // short axis label
    fullLabel: string; // tooltip ("Mon Aug 4" / "Week of Jul 7" / "July 2026")
    cuts: number;
    revenue: number;
  }[];
  /** The whole menu: booked services first, then anything unbooked at 0. */
  services: {
    serviceId: string | null;
    name: string;
    count: number;
    revenue: number;
    /** Menu price/duration (null = no menu match, e.g. a synced free-text name). */
    price: number | null;
    durationMin: number | null;
  }[];
  totals: {
    visits: number;
    revenue: number;
    avgTicket: number;
    pricedCount: number;
    unpricedCount: number;
    uniqueClients: number;
    newClients: number;
    returningClients: number;
    /** Bookings taken with no client record — real cuts, not attributable. */
    walkIns: number;
  };
  busiest: { weekday: string | null; counts: number[] };
  loyalty: { punchesEarned: number; punchesRedeemed: number; redemptions: number };
}

/**
 * Chair utilization: how much of the time the shop was OPEN actually sold.
 * `by=weekday` and `by=period` rows carry real capacity; `by=service` rows share
 * one chair, so their openMin is 0 and utilizationPct means "share of open time".
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
export interface UtilizationData extends PeriodMeta {
  by: "weekday" | "period" | "service";
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
  /** Per-barber views can only show native bookings (a Visit has no staff). */
  syncedExcluded: boolean;
  scheduleCaveat: boolean;
}

// Quota goals. A shop holds one target per (metric, period) — "$4,000 a month"
// and "60 cuts a week" are different goals, each with its own number — so the
// API always returns all four combinations, `target: null` where unset.
export type GoalMetric = "revenue" | "visits";
export type GoalPeriod = "week" | "month";
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
/** The planner's saved levers — how the barber intends to hit the target. */
export interface GoalPlan {
  bookedPct: number; // "if I ran at N% booked"
  services: { serviceId: string; priceDelta: number; extraCuts: number }[];
}
export interface Goal {
  metric: GoalMetric;
  period: GoalPeriod;
  target: number | null; // null = not set yet
  plan: GoalPlan | null;
  progress: GoalProgress | null;
}
/** A per-service quota with its live actual. */
export interface ServiceGoalRow {
  serviceId: string;
  name: string;
  metric: GoalMetric;
  period: GoalPeriod;
  target: number;
  actual: number;
  pct: number;
}
/** Per-service run-rates + schedule capacity, for the what-if projection. */
export interface PlannerData {
  services: {
    serviceId: string;
    name: string;
    price: number | null;
    durationMin: number;
    week: { cuts: number; revenue: number };
    month: { cuts: number; revenue: number };
  }[];
  capacity: {
    week: { openMin: number };
    month: { openMin: number };
  };
}
export interface GoalResponse {
  goals: Goal[];
  chairTime: { target: number | null };
  serviceGoals: ServiceGoalRow[];
  planner: PlannerData;
}

export default async function InsightsPage() {
  const [res, goalRes, me] = await Promise.all([
    apiGet<InsightsData>(`/api/insights?period=${DEFAULT_PERIOD}`),
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
          How your shop is doing: cuts over time, what people book most, and
          where the money comes from. Counts every booking that took the chair —
          native, Acuity and Square alike.
        </p>
      </header>
      <div data-tour="charts">
        <InsightsClient
          initial={res.data}
          initialGoalData={goalRes.ok ? (goalRes.data ?? null) : null}
          rewardsEnabled={me.data?.rewardsEnabled ?? true}
        />
      </div>
    </main>
  );
}
