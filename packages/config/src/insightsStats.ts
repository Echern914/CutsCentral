/**
 * INSIGHTS STATS - the numbers-first strip at the top of Insights, and the
 * goal it suggests underneath.
 *
 * Barbers coming from TheCut asked for this (2026-10-30): "see the raw data
 * first, for a time period the system allows", then goals right below it. They
 * were not setting goals at all because they could not see their numbers.
 *
 * Shared truth, so the API that builds the series and the page that draws it
 * agree on the shape: which grains exist and how many periods each shows, which
 * metrics are cards (and which a Starter shop sees), which way is "good" for
 * each, and the suggested-goal arithmetic.
 *
 * Imported by a "use client" component, so this module stays free of anything
 * server-only. Import it by subpath: `@chairback/config/insightsStats`.
 *
 * NO MODEL. The suggestion is plain arithmetic over the shop's own history -
 * the in-app surfaces stay free to run (costBoundary.test.ts).
 */

export type StatsGrain = "day" | "week" | "month";

/**
 * How many periods each grain shows, newest last. Bounded on purpose ("if you
 * make it infinite it eats storage and memory and makes it laggy"), and the API
 * enforces it: a request can only pick a grain, never a count.
 */
export const STATS_GRAINS: Record<StatsGrain, { count: number; label: string; noun: string }> = {
  day: { count: 14, label: "Day", noun: "day" },
  week: { count: 10, label: "Week", noun: "week" },
  month: { count: 12, label: "Month", noun: "month" },
};

export const STATS_GRAIN_KEYS: readonly StatsGrain[] = ["day", "week", "month"];

/** The largest window any grain may ask for, in periods. The server's cap. */
export const STATS_MAX_PERIODS = Math.max(...STATS_GRAIN_KEYS.map((g) => STATS_GRAINS[g].count));

export const DEFAULT_STATS_GRAIN: StatsGrain = "week";

/** Unknown/absent -> the default, so a stale client never gets a 400. */
export function resolveStatsGrain(raw: unknown): StatsGrain {
  return typeof raw === "string" && (STATS_GRAIN_KEYS as readonly string[]).includes(raw)
    ? (raw as StatsGrain)
    : DEFAULT_STATS_GRAIN;
}

export type StatsMetricKey =
  | "bookings"
  | "revenue"
  | "avgTicket"
  | "tips"
  | "hoursBooked"
  | "newClients"
  | "noShows";

/** count = a plain number, cents = money, minutes = time in the chair. */
export type StatsUnit = "count" | "cents" | "minutes";

export interface StatsMetricSpec {
  key: StatsMetricKey;
  label: string;
  unit: StatsUnit;
  /**
   * A HEADLINE card stays on the Starter sneak peek - the same three numbers
   * the old peek already showed (visits, revenue, average ticket). Everything
   * else is the Premium analysis, matching `insightsScopeFor`.
   */
  headline: boolean;
  /** False where a rise is bad news (no-shows): the arrow turns red going up. */
  higherIsBetter: boolean;
  /** One line under the card saying what it counts. */
  hint: string;
}

/** Card order on the page. */
export const STATS_METRICS: readonly StatsMetricSpec[] = [
  {
    key: "bookings",
    label: "Bookings",
    unit: "count",
    headline: true,
    higherIsBetter: true,
    hint: "Visits that happened. No-shows are counted on their own.",
  },
  {
    key: "revenue",
    label: "Revenue",
    unit: "cents",
    headline: true,
    higherIsBetter: true,
    hint: "Money earned: what you collected, or the price where nothing was recorded. Tips not included.",
  },
  {
    key: "avgTicket",
    label: "Avg ticket",
    unit: "cents",
    headline: true,
    higherIsBetter: true,
    hint: "The average price of a visit that had a price.",
  },
  {
    key: "tips",
    label: "Online tips",
    unit: "cents",
    headline: false,
    higherIsBetter: true,
    hint: "Tips clients left online after a visit. Tips handed over at the chair aren't recorded here.",
  },
  {
    key: "hoursBooked",
    label: "Hours booked",
    unit: "minutes",
    headline: false,
    higherIsBetter: true,
    hint: "Time in the chair, no-shows included, since nobody else could book it.",
  },
  {
    key: "newClients",
    label: "New clients",
    unit: "count",
    headline: false,
    higherIsBetter: true,
    hint: "Clients whose first booking with you fell in that period.",
  },
  {
    key: "noShows",
    label: "No-shows",
    unit: "count",
    headline: false,
    higherIsBetter: false,
    hint: "Booked, held the chair, never came.",
  },
];

export function statsMetricSpec(key: StatsMetricKey): StatsMetricSpec {
  return STATS_METRICS.find((m) => m.key === key)!;
}

export type StatsTrendDirection = "up" | "down" | "flat" | "none";
export type StatsTrendTone = "good" | "bad" | "neutral";

/**
 * Previous period vs current, the way the card's arrow shows it. `none` when
 * either side has no number (an average over zero visits), so the card shows
 * no arrow rather than one that compares against nothing.
 */
export function statsTrend(
  previous: number | null,
  current: number | null,
  higherIsBetter: boolean,
): { direction: StatsTrendDirection; tone: StatsTrendTone } {
  if (previous === null || current === null) return { direction: "none", tone: "neutral" };
  if (current === previous) return { direction: "flat", tone: "neutral" };
  const up = current > previous;
  return { direction: up ? "up" : "down", tone: up === higherIsBetter ? "good" : "bad" };
}

//  The suggested goal

/** The two goal periods the goals API stores. A daily goal does not exist. */
export type SuggestPeriod = "week" | "month";
/** The two goal metrics: whole dollars, or a count of visits. */
export type SuggestMetric = "revenue" | "visits";

/**
 * How many recent COMPLETE periods the average is taken over. Four weeks is a
 * month of rhythm; three months smooths one odd month without reaching back
 * into a different season.
 */
export const SUGGEST_AVERAGE_OVER: Record<SuggestPeriod, number> = { week: 4, month: 3 };

/** The stretch is 10% to 15% over the average - never more than 15%. */
export const SUGGEST_MIN_LIFT = 0.1;
export const SUGGEST_MAX_LIFT = 0.15;

/** The goals API's ceiling, so a suggestion can always be saved as-is. */
export const SUGGEST_MAX_TARGET = 1_000_000;

export interface GoalSuggestion {
  metric: SuggestMetric;
  period: SuggestPeriod;
  /** The suggested target: whole dollars for revenue, a count for visits. */
  target: number;
  /** The average it stretches from, rounded the same way as the target. */
  average: number;
  /** How many complete periods that average covers. */
  periodsAveraged: number;
  /** The best single complete period in the history looked at. */
  best: number;
  /** target / average - 1, as a whole percent, for the "why" line. */
  liftPct: number;
}

/** Round a dollar target to a step a person would actually write down. */
function roundDollars(n: number): number {
  const step = n >= 1000 ? 50 : n >= 100 ? 10 : 5;
  return Math.max(step, Math.round(n / step) * step);
}

/**
 * Next period's suggested goal: the recent average plus a modest, explainable
 * lift, kept realistic by the barber's own best.
 *
 *   history = the COMPLETE periods, oldest first (the in-progress one is NOT
 *             in it - a half-finished week would drag the average down).
 *   1. Drop leading empty periods: a shop that joined three weeks ago has three
 *      weeks of history, not seven weeks with four zeros in front.
 *   2. average = the mean of the last SUGGEST_AVERAGE_OVER[period] of those.
 *   3. lift    = where the barber's BEST period sits above that average,
 *                clamped to 10%..15%. A shop that has already had a much
 *                better week is asked for the full 15%; a very steady shop is
 *                asked for 10%. Never more than 15%: the cap.
 *   4. target  = average x (1 + lift), rounded to a sensible step ($5 / $10 /
 *                $50, or a whole visit), and always at least one step above the
 *                average so a suggestion is never "do what you already do".
 *
 * Null when there is not enough to go on: fewer than two complete periods with
 * any activity. A zero-history shop is told to come back, not handed a number
 * pulled from nowhere.
 */
export function suggestGoal(
  metric: SuggestMetric,
  period: SuggestPeriod,
  history: readonly number[],
): GoalSuggestion | null {
  const firstActive = history.findIndex((v) => v > 0);
  if (firstActive < 0) return null;
  const active = history.slice(firstActive);
  if (active.filter((v) => v > 0).length < 2) return null;

  const window = active.slice(-SUGGEST_AVERAGE_OVER[period]);
  const average = window.reduce((a, b) => a + b, 0) / window.length;
  if (average <= 0) return null;
  const best = Math.max(...active);

  const bestLift = best / average - 1;
  const lift = Math.min(SUGGEST_MAX_LIFT, Math.max(SUGGEST_MIN_LIFT, bestLift));
  const raw = average * (1 + lift);
  const ceiling = average * (1 + SUGGEST_MAX_LIFT);

  let target: number;
  let shownAverage: number;
  if (metric === "revenue") {
    shownAverage = Math.round(average);
    target = roundDollars(raw);
    // Rounding up a step must not break the 15% cap...
    if (target > ceiling) {
      const step = target >= 1000 ? 50 : target >= 100 ? 10 : 5;
      target = Math.max(step, Math.floor(ceiling / step) * step);
    }
    // ...and rounding down must not land at or under the average.
    if (target <= average) target = Math.ceil(average) + 1;
  } else {
    shownAverage = Math.round(average * 10) / 10;
    target = Math.round(raw);
    // One more visit is the smallest real stretch, even when it is more than
    // 15% of a small number (an average of 3 a week asks for 4).
    if (target <= average) target = Math.floor(average) + 1;
  }
  target = Math.min(SUGGEST_MAX_TARGET, Math.max(1, target));

  return {
    metric,
    period,
    target,
    average: shownAverage,
    periodsAveraged: window.length,
    best: metric === "revenue" ? Math.round(best) : best,
    liftPct: Math.round((target / average - 1) * 100),
  };
}
