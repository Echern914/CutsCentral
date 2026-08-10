"use client";

import { useMemo, useState } from "react";
import { pluralServiceNoun } from "@chairback/config/constants";
import { cn } from "@/lib/cn";
import { NumberField } from "@/components/ui/NumberField";
import { Segmented } from "@/components/ui/Segmented";
import { saveGoalAction } from "./actions";
import type { Goal, GoalMetric, GoalPlan, PlannerData } from "./page";

/**
 * The goal planner: turns "set a number" into "here's how you'd actually hit
 * it". For each menu service the barber can pull two levers - charge more, or
 * do more cuts - and pick how booked they intend to run; the projection updates
 * live against the goal line and the plan SAVES with the goal, so the card can
 * keep showing goal vs plan vs actual after reload.
 *
 * Every projection is menu arithmetic on the shop's own numbers - current
 * run-rate x current price - never an estimate pulled from air. Services
 * without a menu price can't be projected and say so instead of pretending.
 */

const CHAIR_PCTS = [50, 60, 70, 80, 90, 100] as const;

type Levers = Record<string, { priceDelta: number; extraCuts: number }>;

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function GoalPlanner({
  goal,
  planner,
  onSaved,
  onClose,
  serviceNoun = "cut",
}: {
  goal: Goal;
  planner: PlannerData;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
  /** The shop's singular visit-noun ("cut"/"twist") for all the copy below. */
  serviceNoun?: string;
}) {
  const period = goal.period;
  const metric = goal.metric;
  const nounPlural = pluralServiceNoun(serviceNoun);
  const [target, setTarget] = useState<number>(
    goal.target ?? (metric === "revenue" ? (period === "week" ? 1000 : 4000) : period === "week" ? 15 : 60),
  );
  const [bookedPct, setBookedPct] = useState<number>(goal.plan?.bookedPct ?? 80);
  const [levers, setLevers] = useState<Levers>(() => {
    const seed: Levers = {};
    for (const l of goal.plan?.services ?? []) {
      seed[l.serviceId] = { priceDelta: l.priceDelta, extraCuts: l.extraCuts };
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lever = (id: string) => levers[id] ?? { priceDelta: 0, extraCuts: 0 };
  const setLever = (id: string, patch: Partial<{ priceDelta: number; extraCuts: number }>) =>
    setLevers((cur) => ({ ...cur, [id]: { ...lever(id), ...patch } }));

  const capacityMin = planner.capacity[period].openMin;
  const sellableMin = Math.round((capacityMin * bookedPct) / 100);

  // The live projection. baseRevenue is what the service REALLY brought in
  // (discounts and all); the levers add on top of it: +Δ price on every cut of
  // it, extra cuts at the new price.
  const proj = useMemo(() => {
    let currentCuts = 0;
    let currentRevenue = 0;
    let plannedCuts = 0;
    let plannedRevenue = 0;
    let plannedMin = 0;
    const rows = planner.services.map((s) => {
      const base = s[period];
      const { priceDelta, extraCuts } = lever(s.serviceId);
      const plannable = s.price !== null;
      const newPrice = plannable ? Math.max(0, s.price! + priceDelta) : null;
      const cuts = base.cuts + (plannable ? extraCuts : 0);
      const revenue = plannable
        ? base.revenue + base.cuts * priceDelta + extraCuts * newPrice!
        : base.revenue;
      currentCuts += base.cuts;
      currentRevenue += base.revenue;
      plannedCuts += cuts;
      plannedRevenue += revenue;
      plannedMin += cuts * s.durationMin;
      // If ONLY this service filled the sellable time - the ceiling Eric asked
      // for: "how much improvement if fully booked at the percentage I choose".
      const maxCuts = s.durationMin > 0 ? Math.floor(sellableMin / s.durationMin) : 0;
      return {
        ...s,
        plannable,
        priceDelta,
        extraCuts,
        newPrice,
        projCuts: cuts,
        projRevenue: revenue,
        maxCuts,
        maxRevenue: newPrice !== null ? maxCuts * newPrice : null,
      };
    });
    return {
      rows,
      currentTotal: metric === "revenue" ? currentRevenue : currentCuts,
      plannedTotal: metric === "revenue" ? plannedRevenue : plannedCuts,
      plannedMin,
    };
  }, [planner.services, levers, period, metric, sellableMin]);

  const fmt = (n: number) =>
    metric === "revenue" ? fmtMoney(n) : `${Math.round(n).toLocaleString()} ${nounPlural}`;
  const overCapacity = proj.plannedMin > sellableMin;
  const deltaToGoal = proj.plannedTotal - target;

  async function save() {
    if (!Number.isInteger(target) || target < 1) {
      setError("Target must be a whole number of at least 1.");
      return;
    }
    setSaving(true);
    setError(null);
    const plan: GoalPlan = {
      bookedPct,
      services: Object.entries(levers)
        .filter(([, l]) => l.priceDelta !== 0 || l.extraCuts > 0)
        .map(([serviceId, l]) => ({ serviceId, ...l })),
    };
    const r = await saveGoalAction({ metric, period, target, plan });
    if (r.ok) {
      await onSaved();
      onClose();
    } else {
      setError("Couldn't save the plan. Try again.");
      setSaving(false);
    }
  }

  const metricLabel = metric === "revenue" ? "Revenue" : `Completed ${nounPlural}`;
  const periodNoun = period === "week" ? "week" : "month";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative z-10 flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-subtle bg-charcoal-900 sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-subtle px-5 py-4">
          <div>
            <h2 className="font-display text-lg text-offwhite">
              {metricLabel} goal · per {periodNoun}
            </h2>
            <p className="text-[11px] text-muted">
              Set the number, then pull the levers that get you there.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-subtle px-3 py-1 text-xs text-muted hover:text-offwhite"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* The goal itself + the capacity assumption. */}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <label className="block">
              <span className="text-xs text-muted">
                Target {metric === "revenue" ? "($ per " : `(${nounPlural} per `}
                {periodNoun})
              </span>
              <NumberField
                value={target}
                onChange={setTarget}
                min={1}
                max={1_000_000}
                integer
                className="mt-1 w-32 rounded-xl border border-subtle bg-charcoal-800 px-3 py-2 text-sm tabular-nums"
                aria-label={`${metricLabel} target per ${periodNoun}`}
              />
            </label>
            <div>
              <span className="text-xs text-muted">If I run at…</span>
              <div className="mt-1 flex items-center gap-2">
                <Segmented
                  options={CHAIR_PCTS.map((p) => ({ key: String(p), label: `${p}%` }))}
                  value={String(bookedPct)}
                  onChange={(k) => setBookedPct(Number(k))}
                  ariaLabel="Booked percentage"
                />
              </div>
            </div>
          </div>
          <p className="-mt-2 text-[11px] text-muted">
            Your schedule holds{" "}
            <span className="tabular-nums text-offwhite">{fmtHours(capacityMin)}</span> of
            chair time a {periodNoun}; at {bookedPct}% booked that&apos;s{" "}
            <span className="tabular-nums text-offwhite">{fmtHours(sellableMin)}</span> to
            sell.
          </p>

          {/* Projection: actual so far vs the plan vs the goal line. */}
          <PlanProjection
            goal={goal}
            target={target}
            plannedTotal={proj.plannedTotal}
            metric={metric}
          />

          {/* The verdict sentence - the whole point, in one line. */}
          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-sm",
              deltaToGoal >= 0
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300",
            )}
          >
            At these prices and volumes you&apos;d make{" "}
            <span className="font-semibold tabular-nums">{fmt(proj.plannedTotal)}</span> a{" "}
            {periodNoun}
            {" — "}
            {deltaToGoal >= 0 ? (
              <>
                <span className="font-semibold tabular-nums">{fmt(deltaToGoal)}</span> over
                your goal.
              </>
            ) : (
              <>
                <span className="font-semibold tabular-nums">{fmt(-deltaToGoal)}</span>{" "}
                short of your goal — add {nounPlural} or raise a price below.
              </>
            )}
            {proj.plannedTotal !== proj.currentTotal && (
              <span className="text-[11px] opacity-80">
                {" "}
                (currently {fmt(proj.currentTotal)})
              </span>
            )}
          </div>
          {overCapacity && (
            <p role="alert" className="-mt-2 text-[11px] text-amber-400">
              Heads up: this plan needs {fmtHours(proj.plannedMin)} of chair time — more
              than the {fmtHours(sellableMin)} you&apos;d have at {bookedPct}% booked.
              Raise prices instead of volume, or pick a higher booked %.
            </p>
          )}

          {/* The levers, one row per menu service. */}
          <div>
            <div className="mb-2 grid grid-cols-[1fr_5rem_5rem] items-end gap-2 text-[10px] uppercase tracking-wide text-muted sm:grid-cols-[1fr_5rem_5rem_auto]">
              <span>Service · today</span>
              <span>Price +/-$</span>
              <span>More {nounPlural}</span>
              <span className="hidden text-right sm:block">
                Ceiling at {bookedPct}%
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-subtle/60">
              {proj.rows.map((s) => (
                <li
                  key={s.serviceId}
                  className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 py-2 sm:grid-cols-[1fr_5rem_5rem_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-offwhite" title={s.name}>
                      {s.name}
                    </p>
                    <p className="text-[11px] tabular-nums text-muted">
                      {s.plannable ? (
                        <>
                          {fmtMoney(s.price!)}
                          {s.priceDelta !== 0 && (
                            <span
                              className={cn(
                                "font-semibold",
                                s.priceDelta > 0 ? "text-emerald-400" : "text-amber-400",
                              )}
                            >
                              {" "}
                              → {fmtMoney(s.newPrice!)}
                            </span>
                          )}
                          {" · "}
                          {s[period].cuts}
                          {s.extraCuts > 0 && (
                            <span className="font-semibold text-emerald-400">
                              {" "}
                              → {s.projCuts}
                            </span>
                          )}{" "}
                          / {periodNoun} · {s.durationMin}m
                        </>
                      ) : (
                        <>no menu price — can&apos;t project this one</>
                      )}
                    </p>
                  </div>
                  {s.plannable ? (
                    <>
                      {/* blankAtFallback: these two are "no change" levers, so a
                          literal 0 sitting in the box is something to type
                          around rather than a value. See NumberField. */}
                      <NumberField
                        value={s.priceDelta}
                        onChange={(n) => setLever(s.serviceId, { priceDelta: n })}
                        min={-1000}
                        max={1000}
                        integer
                        emptyValue={0}
                        blankAtFallback
                        className="w-full rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-right text-sm tabular-nums"
                        aria-label={`Price change for ${s.name}`}
                      />
                      <NumberField
                        value={s.extraCuts}
                        onChange={(n) => setLever(s.serviceId, { extraCuts: n })}
                        min={0}
                        max={1000}
                        integer
                        emptyValue={0}
                        blankAtFallback
                        className="w-full rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-right text-sm tabular-nums"
                        aria-label={`Extra ${nounPlural} per ${periodNoun} for ${s.name}`}
                      />
                      <span
                        className="hidden text-right text-[11px] tabular-nums text-muted sm:block"
                        title={`If ${s.name} alone filled your ${bookedPct}%-booked chair time this ${periodNoun}.`}
                      >
                        {s.maxCuts} {nounPlural}
                        {s.maxRevenue !== null && (
                          <span className="block text-offwhite">{fmtMoney(s.maxRevenue)}</span>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="col-span-2 sm:col-span-3" />
                  )}
                </li>
              ))}
              {proj.rows.length === 0 && (
                <li className="py-3 text-sm text-muted">
                  No services on the menu yet — add them under Booking → Services
                  and come back to plan with real numbers.
                </li>
              )}
            </ul>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-subtle px-5 py-3">
          <p className="text-[11px] text-muted">
            The plan saves with the goal — your card shows goal vs plan vs actual.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-subtle px-3 py-1.5 text-sm text-muted hover:text-offwhite"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded-xl bg-gold px-4 py-1.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save goal & plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Actual-so-far vs the plan's trajectory vs the goal, over the period's days.
 * Purpose-built three-series SVG: LineChart.tsx is single-series by design
 * (its docblock says so), and a projection needs exactly these three lines and
 * nothing else - no library, same as every other chart on the page.
 */
function PlanProjection({
  goal,
  target,
  plannedTotal,
  metric,
}: {
  goal: Goal;
  target: number;
  plannedTotal: number;
  metric: GoalMetric;
}) {
  const p = goal.progress;
  const totalDays = p?.totalDays ?? (goal.period === "week" ? 7 : 30);
  const actualPts = (p?.series ?? []).filter(
    (s): s is { day: number; cumulative: number } => s.cumulative !== null,
  );
  const top = Math.max(target, plannedTotal, actualPts.at(-1)?.cumulative ?? 0, 1) * 1.08;

  const W = 300;
  const H = 90;
  const x = (day: number) => (day / totalDays) * W;
  const y = (v: number) => H - (v / top) * H;
  const line = (to: number) => `M ${x(0)} ${y(0)} L ${x(totalDays)} ${y(to)}`;
  const actualPath =
    actualPts.length > 0
      ? `M ${x(0)} ${y(0)} ` + actualPts.map((s) => `L ${x(s.day)} ${y(s.cumulative)}`).join(" ")
      : null;

  const fmt = (n: number) =>
    metric === "revenue" ? fmtMoney(n) : `${Math.round(n).toLocaleString()}`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[88px] w-full"
        role="img"
        aria-label={`Projection: plan reaches ${fmt(plannedTotal)}, goal is ${fmt(target)}${
          actualPts.length > 0 ? `, actual so far ${fmt(actualPts.at(-1)!.cumulative)}` : ""
        }`}
      >
        {/* goal line */}
        <path
          d={line(target)}
          fill="none"
          stroke="rgb(232 230 227 / 0.45)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
        {/* plan trajectory */}
        <path
          d={line(plannedTotal)}
          fill="none"
          stroke="rgb(52 211 153 / 0.85)"
          strokeWidth={1.5}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
        {/* actual cumulative */}
        {actualPath && (
          <path
            d={actualPath}
            fill="none"
            stroke="rgb(212 175 55 / 0.95)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-gold" /> Actual so far
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-b border-dashed border-emerald-400" /> Your plan
          → {fmt(plannedTotal)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-b border-dashed border-offwhite/50" /> Goal ·{" "}
          {fmt(target)}
        </span>
      </div>
    </div>
  );
}
