"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useId, useMemo, useState } from "react";
import { pluralServiceNoun } from "@chairback/config/constants";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/duration";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { NumberField } from "@/components/ui/NumberField";
import { Segmented } from "@/components/ui/Segmented";
import { NAME_WRAP_CLS } from "../_components/appointmentCardStyles";
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
 *
 * PRESENTATION NOTES (the arithmetic above is untouched - this file owns no
 * revenue definition, and none changed here):
 *
 *   - The shell is <Dialog>, which PORTALS to document.body. It has to: this
 *     component renders inside the Goals <Card>, and `.glass` sets
 *     `backdrop-filter`, which makes that card a containing block for FIXED
 *     descendants and its own stacking context. Rendered in place, the
 *     backdrop sized itself to the card, the dialog hung off the bottom of the
 *     screen with its footer, and every later card on the page painted over
 *     it. See the docblock in components/ui/Dialog.tsx.
 *   - Four numbers answer "where am I" before any lever: TARGET, BOOKED %,
 *     THIS PLAN, GAP.
 *   - The verdict is charcoal body copy on a faint tint with a brass mark -
 *     gold is the accent, never the paragraph.
 */

const CHAIR_PCTS = [50, 60, 70, 80, 90, 100] as const;

type Levers = Record<string, { priceDelta: number; extraCuts: number }>;

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// Capacity here is a whole period of chair time - a month of it runs to
// hundreds of hours - so it goes through the shared days/hours/minutes
// formatter rather than a bare hour count. See lib/duration.ts.

export function GoalPlanner({
  goal,
  planner,
  onSaved,
  onClose,
  serviceNoun = "visit",
}: {
  goal: Goal;
  planner: PlannerData;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
  /** The shop's singular visit-noun ("cut"/"twist") for all the copy below. */
  serviceNoun?: string;
}) {
  const vocab = useVocab();
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
  const errorId = useId();

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
        serviceId: s.serviceId,
        name: s.name,
        price: s.price,
        durationMin: s.durationMin,
        baseCuts: base.cuts,
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
  const onTrack = deltaToGoal >= 0;

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
  const unitSuffix = metric === "revenue" ? `$ per ${periodNoun}` : `${nounPlural} per ${periodNoun}`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${metricLabel} goal · per ${periodNoun}`}
      subtitle="Set the number, then pull the levers that get you there."
      className="max-w-2xl"
      footer={
        <>
          <p className="hidden text-[11px] leading-snug text-muted sm:block sm:max-w-[20rem]">
            The plan saves with the goal — your card shows goal vs plan vs actual.
          </p>
          {/* Below ~380px "Save goal & plan" wraps to two lines inside a
              half-width button. Stack them full width instead (-reverse puts
              the primary on top) rather than abbreviating the label. */}
          <div className="flex w-full gap-2 max-[380px]:flex-col-reverse sm:w-auto sm:shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 flex-1 items-center justify-center rounded-xl border border-subtle px-4 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite max-[380px]:flex-none sm:h-10 sm:flex-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex h-11 flex-1 items-center justify-center rounded-xl bg-gold px-4 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50 max-[380px]:flex-none sm:h-10 sm:flex-none"
            >
              {saving ? "Saving…" : "Save goal & plan"}
            </button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── The four facts, before any lever: the target, how booked you
            intend to run, what this plan makes, and the gap. ───────────── */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-subtle bg-[rgb(var(--cb-fg)/0.06)] sm:grid-cols-4">
          <Stat label="Target" value={fmt(target)} sub={`per ${periodNoun}`} />
          <Stat label="Booked at" value={`${bookedPct}%`} sub={`of open ${vocab.stationNoun} time`} />
          <Stat label="This plan" value={fmt(proj.plannedTotal)} sub={`per ${periodNoun}`} />
          <Stat
            label={onTrack ? "Over goal" : "Gap to goal"}
            value={fmt(Math.abs(deltaToGoal))}
            sub={onTrack ? "ahead of target" : "still to find"}
            tone={onTrack ? "good" : "attention"}
          />
        </div>

        {/* ── The two inputs that move everything above. ─────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
          <label className="block sm:flex-none">
            {/* `block`: an inline span puts the caption BESIDE the input, which
                is how the two numeric controls fell out of alignment. */}
            <span className="block text-xs font-medium text-muted">
              Target ({unitSuffix})
            </span>
            <NumberField
              value={target}
              onChange={(n) => {
                setTarget(n);
                if (error) setError(null);
              }}
              min={1}
              max={1_000_000}
              integer
              className="mt-1.5 h-11 w-full rounded-xl border border-subtle bg-charcoal-800 px-3 text-base tabular-nums text-offwhite sm:h-10 sm:w-36"
              aria-label={`${metricLabel} target per ${periodNoun}`}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <div className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-muted">If I run at…</span>
            <Segmented
              className="mt-1.5 max-w-full flex-wrap"
              size="comfortable"
              options={CHAIR_PCTS.map((p) => ({ key: String(p), label: `${p}%` }))}
              value={String(bookedPct)}
              onChange={(k) => setBookedPct(Number(k))}
              ariaLabel="Booked percentage"
            />
            <p className="mt-2 text-[11px] leading-snug text-muted">
              Your schedule holds{" "}
              <span className="tabular-nums text-offwhite">{fmtDuration(capacityMin)}</span> of
              chair time a {periodNoun}; at {bookedPct}% booked that&apos;s{" "}
              <span className="tabular-nums text-offwhite">{fmtDuration(sellableMin)}</span> to
              sell.
            </p>
          </div>
        </div>

        {/* ── The verdict: readable body copy on a faint tint, brass mark. ── */}
        <div
          className={cn(
            "flex items-start gap-3 rounded-2xl border px-4 py-3",
            onTrack
              ? "border-emerald-soft/30 bg-emerald-soft/[0.07]"
              : "border-gold/30 bg-gold/[0.07]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full",
              onTrack ? "bg-emerald-soft/15 text-emerald-soft" : "bg-gold/15 text-gold",
            )}
          >
            {onTrack ? <CheckMark /> : <TargetMark />}
          </span>
          <div className="min-w-0 text-sm leading-relaxed text-offwhite">
            <p className="font-semibold">
              <span className="tabular-nums">{fmt(Math.abs(deltaToGoal))}</span>{" "}
              {onTrack ? "over your goal." : "short of your goal."}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted">
              At these prices and volumes you&apos;d make{" "}
              <span className="tabular-nums text-offwhite">{fmt(proj.plannedTotal)}</span> a{" "}
              {periodNoun} against a target of{" "}
              <span className="tabular-nums text-offwhite">{fmt(target)}</span>
              {proj.plannedTotal !== proj.currentTotal && (
                <>
                  {" "}
                  — you&apos;re at{" "}
                  <span className="tabular-nums text-offwhite">{fmt(proj.currentTotal)}</span>{" "}
                  today
                </>
              )}
              {". "}
              {!onTrack && <>Add {nounPlural} or raise a price below.</>}
            </p>
          </div>
        </div>

        {overCapacity && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-gold/25 bg-gold/[0.05] px-3.5 py-2.5 text-[13px] leading-snug text-offwhite"
          >
            <span aria-hidden className="mt-0.5 flex-none text-gold">
              <TargetMark />
            </span>
            <span>
              This plan needs{" "}
              <span className="tabular-nums">{fmtDuration(proj.plannedMin)}</span> of chair time
              — more than the{" "}
              <span className="tabular-nums">{fmtDuration(sellableMin)}</span> you&apos;d have
              at {bookedPct}% booked. Raise prices instead of volume, or pick a higher
              booked&nbsp;%.
            </span>
          </p>
        )}

        {/* Actual vs plan vs goal - compact, and a summary rather than a blank
            graph when there is nothing logged yet. */}
        <PlanProjection
          goal={goal}
          target={target}
          plannedTotal={proj.plannedTotal}
          metric={metric}
          periodNoun={periodNoun}
          nounPlural={nounPlural}
        />

        {/* ── The levers, one row per menu service. ──────────────────────── */}
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            Your menu
          </h3>
          {/* Column headings exist only where the columns do (sm+); the mobile
              rows carry their own inline labels instead. */}
          <div className="mt-2 hidden grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_7rem] items-end gap-3 border-b border-subtle pb-2 text-[10px] uppercase tracking-wide text-muted sm:grid">
            <span>Service · today</span>
            <span className="text-right">Price ±$</span>
            <span className="text-right">More {nounPlural}</span>
            <span className="text-right">Ceiling at {bookedPct}%</span>
          </div>
          <ul className="flex flex-col divide-y divide-subtle/60">
            {proj.rows.map((s) => (
              <ServiceRow
                key={s.serviceId}
                s={s}
                periodNoun={periodNoun}
                nounPlural={nounPlural}
                bookedPct={bookedPct}
                onPrice={(n) => setLever(s.serviceId, { priceDelta: n })}
                onCuts={(n) => setLever(s.serviceId, { extraCuts: n })}
              />
            ))}
            {proj.rows.length === 0 && (
              <li className="py-4 text-sm text-muted">
                No services on the menu yet — add them under Booking → Services and come back
                to plan with real numbers.
              </li>
            )}
          </ul>
        </div>

        <FormError id={errorId}>{error}</FormError>

        <p className="text-[11px] leading-snug text-muted sm:hidden">
          The plan saves with the goal — your card shows goal vs plan vs actual.
        </p>
      </div>
    </Dialog>
  );
}

type PlannedRow = {
  serviceId: string;
  name: string;
  price: number | null;
  durationMin: number;
  baseCuts: number;
  plannable: boolean;
  priceDelta: number;
  extraCuts: number;
  newPrice: number | null;
  projCuts: number;
  maxCuts: number;
  maxRevenue: number | null;
};

/** One cell of the at-a-glance row. */
function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "neutral" | "good" | "attention";
}) {
  return (
    <div className="bg-charcoal-800 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-display text-lg leading-tight tabular-nums [overflow-wrap:anywhere]",
          tone === "good" && "text-emerald-soft",
          tone === "attention" && "text-gold",
          tone === "neutral" && "text-offwhite",
        )}
      >
        {value}
      </p>
      <p className="text-[10px] leading-snug text-muted">{sub}</p>
    </div>
  );
}

/**
 * One menu service. Mobile stacks - the name gets its own full-width line, then
 * the two levers sit side by side under their own labels, then the ceiling.
 * From `sm` the row lines up with the column headings above (the wrappers go
 * `display: contents` so one markup serves both).
 *
 * The name NEVER truncates: same rule the appointment cards settled on, same
 * NAME_WRAP_CLS, because "Signature Skin Fade…" and "Signature Skin Fade with
 * Beard" are a different price and a different plan.
 */
function ServiceRow({
  s,
  periodNoun,
  nounPlural,
  bookedPct,
  onPrice,
  onCuts,
}: {
  s: PlannedRow;
  periodNoun: string;
  nounPlural: string;
  bookedPct: number;
  onPrice: (n: number) => void;
  onCuts: (n: number) => void;
}) {
  const vocab = useVocab();
  // text-base (16px) is the iOS no-zoom floor; it relaxes to text-sm from `sm`,
  // where there is no touch keyboard to trigger it. See globals.css.
  const fieldCls =
    "h-11 w-full rounded-lg border border-subtle bg-charcoal-800 px-2 text-right text-base tabular-nums text-offwhite sm:h-10 sm:text-sm";

  return (
    <li className="py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_7rem] sm:items-center sm:gap-3">
      <div className="min-w-0">
        <p className={cn(NAME_WRAP_CLS, "text-sm")}>{s.name}</p>
        <p className="mt-0.5 text-[11px] tabular-nums text-muted">
          {s.plannable ? (
            <>
              {fmtMoney(s.price!)}
              {s.priceDelta !== 0 && (
                <span
                  className={cn(
                    "font-semibold",
                    s.priceDelta > 0 ? "text-emerald-soft" : "text-gold",
                  )}
                >
                  {" → "}
                  {fmtMoney(s.newPrice!)}
                </span>
              )}
              {" · "}
              {s.baseCuts} / {periodNoun}
              {s.extraCuts > 0 && (
                <span className="font-semibold text-emerald-soft">
                  {" → "}
                  {s.projCuts}
                </span>
              )}
              {" · "}
              {s.durationMin}m
            </>
          ) : (
            <>no menu price — can&apos;t project this one</>
          )}
        </p>
      </div>

      {s.plannable ? (
        <>
          {/* blankAtFallback: these two are "no change" levers, so a literal 0
              sitting in the box is something to type around rather than a
              value. See NumberField. */}
          <div className="mt-2 grid grid-cols-2 gap-2 sm:mt-0 sm:contents">
            <label className="block sm:contents">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-muted sm:hidden">
                Price ±$
              </span>
              <NumberField
                value={s.priceDelta}
                onChange={onPrice}
                min={-1000}
                max={1000}
                integer
                emptyValue={0}
                blankAtFallback
                className={fieldCls}
                aria-label={`Price change for ${s.name}`}
              />
            </label>
            <label className="block sm:contents">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-muted sm:hidden">
                More {nounPlural}
              </span>
              <NumberField
                value={s.extraCuts}
                onChange={onCuts}
                min={0}
                max={1000}
                integer
                emptyValue={0}
                blankAtFallback
                className={fieldCls}
                aria-label={`Extra ${nounPlural} per ${periodNoun} for ${s.name}`}
              />
            </label>
          </div>
          <p
            className="mt-2 text-[11px] leading-snug tabular-nums text-muted sm:mt-0 sm:text-right"
            title={`If ${s.name} alone filled your ${bookedPct}%-booked ${vocab.stationNoun} time this ${periodNoun}.`}
          >
            <span className="sm:hidden">Ceiling at {bookedPct}%: </span>
            {s.maxCuts} {nounPlural}
            {s.maxRevenue !== null && (
              <>
                <span className="sm:hidden"> · </span>
                <span className="text-offwhite sm:block">{fmtMoney(s.maxRevenue)}</span>
              </>
            )}
          </p>
        </>
      ) : (
        <span className="hidden sm:col-span-3 sm:block" />
      )}
    </li>
  );
}

/**
 * Actual-so-far vs the plan's trajectory vs the goal, over the period's days.
 * Purpose-built three-series SVG: LineChart.tsx is single-series by design
 * (its docblock says so), and a projection needs exactly these three lines and
 * nothing else - no library, same as every other chart on the page.
 *
 * With NOTHING logged yet - a goal being set for the first time, or day one of
 * the period - the "chart" was two straight rules over a flat zero: a tall box
 * of nothing. That case gets a meter and a sentence instead.
 */
function PlanProjection({
  goal,
  target,
  plannedTotal,
  metric,
  periodNoun,
  nounPlural,
}: {
  goal: Goal;
  target: number;
  plannedTotal: number;
  metric: GoalMetric;
  periodNoun: string;
  nounPlural: string;
}) {
  const p = goal.progress;
  const totalDays = p?.totalDays ?? (goal.period === "week" ? 7 : 30);
  const actualPts = (p?.series ?? []).filter(
    (s): s is { day: number; cumulative: number } => s.cumulative !== null,
  );
  const top = Math.max(target, plannedTotal, actualPts.at(-1)?.cumulative ?? 0, 1) * 1.08;

  const fmt = (n: number) =>
    metric === "revenue" ? fmtMoney(n) : `${Math.round(n).toLocaleString()} ${nounPlural}`;

  // One point is not a trend; below two there is nothing to plot.
  if (actualPts.length < 2) {
    const pct = Math.max(0, Math.min(100, (plannedTotal / Math.max(target, 1)) * 100));
    return (
      <div className="rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            This plan vs your goal
          </p>
          <p className="text-[11px] tabular-nums text-muted">
            <span className="text-offwhite">{fmt(plannedTotal)}</span> of {fmt(target)}
          </p>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[rgb(var(--cb-fg)/0.08)]"
          role="img"
          aria-label={`This plan reaches ${fmt(plannedTotal)} of a ${fmt(target)} goal.`}
        >
          <div
            className="h-full rounded-full bg-gold transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted">
          Nothing logged yet this {periodNoun} — this is the plan, not history. The line chart
          fills in as {nounPlural} complete.
        </p>
      </div>
    );
  }

  const W = 300;
  const H = 60;
  const x = (day: number) => (day / totalDays) * W;
  const y = (v: number) => H - (v / top) * H;
  const line = (to: number) => `M ${x(0)} ${y(0)} L ${x(totalDays)} ${y(to)}`;
  const actualPath =
    `M ${x(0)} ${y(0)} ` + actualPts.map((s) => `L ${x(s.day)} ${y(s.cumulative)}`).join(" ");

  return (
    <div className="rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
        Actual vs plan vs goal
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="mt-2 h-14 w-full"
        role="img"
        aria-label={`Projection: plan reaches ${fmt(plannedTotal)}, goal is ${fmt(target)}, actual so far ${fmt(actualPts.at(-1)!.cumulative)}`}
      >
        {/* goal line */}
        <path
          d={line(target)}
          fill="none"
          stroke="rgb(var(--cb-fg) / 0.45)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
        {/* plan trajectory */}
        <path
          d={line(plannedTotal)}
          fill="none"
          stroke="rgb(var(--cb-emerald) / 0.85)"
          strokeWidth={1.5}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
        {/* actual cumulative */}
        <path
          d={actualPath}
          fill="none"
          stroke="rgb(var(--cb-gold) / 0.95)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-gold" /> Actual so far
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-b border-dashed border-emerald-soft" /> Your plan →{" "}
          {fmt(plannedTotal)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-b border-dashed border-offwhite/50" /> Goal ·{" "}
          {fmt(target)}
        </span>
      </div>
    </div>
  );
}

function TargetMark() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 13 4.5 4.5L19 7" />
    </svg>
  );
}
