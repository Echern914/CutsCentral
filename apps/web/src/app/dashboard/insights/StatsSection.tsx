"use client";

import { useState } from "react";
import {
  STATS_METRICS,
  statsMetricSpec,
  statsTrend,
  type StatsGrain,
  type StatsMetricKey,
  type StatsUnit,
} from "@chairback/config/insightsStats";
import { pluralServiceNoun } from "@chairback/config/constants";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/cn";
import { PlanBadge } from "../_components/PlanBadge";
import { fmtCents } from "./ExpensesCard";
import type { StatsData } from "./page";

/**
 * STATS - the numbers first, before any goal.
 *
 * Asked for by shop owners who came from another booking app: one page of raw
 * numbers, a Day / Week / Month switch, and a small bar per period you can tap
 * for that period's exact value. Goals sit underneath, once the numbers are
 * clear.
 *
 * Every number comes from GET /api/insights/stats, which reads the same booking
 * stream as the rest of Insights (synced calendars included). The window is a
 * fixed, bounded run of periods per grain - the page never asks for more.
 */
export function StatsSection({
  stats,
  grain,
  pending,
  failed,
  onGrain,
  serviceNoun,
}: {
  stats: StatsData;
  grain: StatsGrain;
  pending: boolean;
  failed: boolean;
  onGrain: (g: StatsGrain) => void;
  serviceNoun: string;
}) {
  const peek = stats.scope === "peek";
  // The cards render in the shared order; a metric the API left out (online
  // tips at a shop that never offered them) simply has no card.
  const byKey = new Map(stats.metrics.map((m) => [m.key, m]));
  const cards = STATS_METRICS.filter((m) => byKey.has(m.key));
  const likeForLike = stats.metrics.some((m) => m.previousToDate !== undefined);

  return (
    <section aria-labelledby="stats-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 id="stats-heading" className="font-display text-xl tracking-tight">
            Stats
          </h2>
          <p className="text-[11px] text-muted">
            {peek
              ? "This period next to the last one, in your shop's time."
              : `The last ${stats.periods.length} ${stats.grain}s, in your shop's time. Tap a bar for its number.`}
            {likeForLike && (
              <span data-testid="stats-basis">
                {` Arrows compare this ${stats.grain} so far with last ${stats.grain} up to the same point.`}
              </span>
            )}
            {pending && " Updating…"}
          </p>
        </div>
        <Segmented
          options={stats.grains}
          value={grain}
          onChange={onGrain}
          ariaLabel="Stats period"
          size="comfortable"
        />
      </div>
      {failed && (
        <p role="alert" className="text-[11px] text-warning-soft">
          Couldn&apos;t load that view. Still showing the last one.
        </p>
      )}
      <div
        className={cn(
          "grid grid-cols-2 gap-3 transition-opacity duration-150 ease-out sm:grid-cols-3",
          pending && "opacity-60",
        )}
        data-testid="stats-grid"
      >
        {cards.map((spec) => {
          const m = byKey.get(spec.key)!;
          return (
            <StatCard
              // Re-key on the grain so a tapped bar never survives into a
              // different set of periods.
              key={`${spec.key}:${stats.grain}`}
              metric={spec.key}
              label={spec.key === "bookings" ? cap(pluralServiceNoun(serviceNoun)) : spec.label}
              locked={m.locked}
              values={m.values}
              previousToDate={m.previousToDate}
              periods={stats.periods}
              noun={stats.grain}
              showBars={!peek}
            />
          );
        })}
      </div>
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Hours read as hours here ("38h", "6.5h") - "1d 14h" is not how anyone counts booked time. */
function fmtHours(min: number): string {
  const h = min / 60;
  if (h === 0) return "0h";
  return h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
}

/** One number in its unit. Null = there was nothing to measure (no priced visit). */
export function fmtStat(unit: StatsUnit, v: number | null): string {
  if (v === null) return "–";
  if (unit === "cents") return fmtCents(v);
  if (unit === "minutes") return fmtHours(v);
  return v.toLocaleString("en-US");
}

function StatCard({
  metric,
  label,
  locked,
  values,
  previousToDate,
  periods,
  noun,
  showBars,
}: {
  metric: StatsMetricKey;
  label: string;
  locked: boolean;
  values: (number | null)[];
  previousToDate?: number | null;
  periods: StatsData["periods"];
  noun: string;
  showBars: boolean;
}) {
  const spec = statsMetricSpec(metric);
  const [selected, setSelected] = useState<number | null>(null);

  if (locked) {
    return (
      <div className="flex min-w-0" data-testid={`stat-${metric}`} data-locked="true">
        <Card className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
            <PlanBadge tier="pro" />
          </div>
          <p className="text-[11px] leading-snug text-muted">{spec.hint}</p>
        </Card>
      </div>
    );
  }

  const last = values.length - 1;
  const current = values[last] ?? null;
  // The period in progress is never finished, so it is compared with the
  // previous one UP TO THE SAME POINT (the API's previousToDate) - not with the
  // whole of it, which would read as a drop every morning. The previous bar
  // still shows that whole period.
  const likeForLike = previousToDate !== undefined;
  const previous = last > 0 ? (likeForLike ? previousToDate : (values[last - 1] ?? null)) : null;
  const trend = statsTrend(previous, current, spec.higherIsBetter);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const shown = selected ?? last;
  const readout = `${periods[shown]?.fullLabel ?? ""}: ${fmtStat(spec.unit, values[shown] ?? null)}`;

  return (
    <div className="flex min-w-0" data-testid={`stat-${metric}`}>
    <Card className="flex min-w-0 flex-1 flex-col p-3.5">
      <p title={spec.hint} className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 font-display text-2xl tabular-nums text-offwhite [overflow-wrap:anywhere]">
        {fmtStat(spec.unit, current)}
      </p>

      {showBars && (
        <>
          <div
            role="group"
            aria-label={`${label}, one bar per ${noun}`}
            className="mt-2 flex h-14 items-stretch gap-[2px]"
          >
            {values.map((v, i) => {
              const isCurrent = i === last;
              const isSelected = selected === i;
              const pct = v === null || v === 0 ? 0 : Math.max(6, Math.round((v / max) * 100));
              const p = periods[i];
              return (
                <button
                  key={p?.key ?? i}
                  type="button"
                  aria-label={`${p?.fullLabel ?? ""}: ${fmtStat(spec.unit, v)}`}
                  aria-pressed={isSelected}
                  // Select, never toggle: a real tap FOCUSES the button first
                  // (which already selected it), so a toggle on the click that
                  // follows would clear the readout the tap just opened.
                  onClick={() => setSelected(i)}
                  onFocus={() => setSelected(i)}
                  // The hit target is the whole column, not just the bar.
                  className="group flex min-w-0 flex-1 items-end rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gold"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "block w-full rounded-t-[3px] transition-colors duration-150 ease-out",
                      pct === 0 ? "h-[2px] bg-muted/25" : "",
                      pct > 0 && (isCurrent ? "bg-gold" : "bg-muted/35 group-hover:bg-muted/60"),
                      isSelected && "outline outline-1 outline-offset-1 outline-offwhite",
                    )}
                    style={pct > 0 ? { height: `${pct}%` } : undefined}
                  />
                </button>
              );
            })}
          </div>
          {/* The tapped (or focused) bar's exact number. Polite live region,
              so a screen reader hears it without losing its place. */}
          <p className="mt-1 min-h-[1rem] truncate text-[10px] tabular-nums text-muted" aria-live="polite" data-testid={`stat-${metric}-readout`}>
            {selected === null ? "" : readout}
          </p>
        </>
      )}

      {/* Previous vs current, the way the other app showed it. */}
      <div className="mt-auto flex items-end justify-between gap-2 pt-1 text-[10px] tabular-nums">
        <span className="min-w-0 truncate text-muted">
          {last > 0 && (
            <>
              {periods[last - 1]?.label} · {fmtStat(spec.unit, previous)}
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-offwhite">
          {periods[last]?.label} · {fmtStat(spec.unit, current)}
          <TrendMark direction={trend.direction} tone={trend.tone} />
        </span>
      </div>

    </Card>
    </div>
  );
}

/** The arrow, always with words for assistive tech - never colour alone. */
function TrendMark({
  direction,
  tone,
}: {
  direction: "up" | "down" | "flat" | "none";
  tone: "good" | "bad" | "neutral";
}) {
  if (direction === "none") return null;
  const color =
    tone === "good" ? "text-emerald-soft" : tone === "bad" ? "text-danger-soft" : "text-muted";
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "=";
  const words = direction === "up" ? "up from last period" : direction === "down" ? "down from last period" : "same as last period";
  return (
    <span className={color} data-trend={direction} data-tone={tone}>
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}
