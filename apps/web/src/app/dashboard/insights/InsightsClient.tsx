"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardHeader } from "@/components/ui/Card";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import type { GoalData, GoalResponse, InsightsData } from "./page";
import {
  clearGoalAction,
  goalAction,
  insightsAction,
  saveGoalAction,
} from "./actions";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The barber's analytics page. Same dependency-free chart approach as
 * TrendsChart: scaled divs, no chart library. The default (12w) range renders
 * the server prop; other ranges re-fetch and never go stale.
 */
export function InsightsClient({
  initial,
  initialGoal = null,
  rewardsEnabled = true,
}: {
  initial: InsightsData;
  initialGoal?: GoalResponse | null;
  rewardsEnabled?: boolean;
}) {
  const [range, setRange] = useState(12);
  const [override, setOverride] = useState<InsightsData | null>(null);
  const [pending, setPending] = useState(false);
  const data = range === 12 ? initial : (override ?? initial);

  useEffect(() => {
    if (range === 12) {
      setOverride(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    void insightsAction(range).then((d) => {
      if (cancelled) return;
      if (d) setOverride(d);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const { weeks, services, totals, busiest, loyalty } = data;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6"
    >
      {/* The quota goal — the motivational headline, above everything. */}
      <motion.div variants={fadeUp}>
        <GoalCard initial={initialGoal} />
      </motion.div>

      {/* Headline numbers for the window */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={`Cuts (${range}w)`} value={String(totals.visits)} accent />
        <Tile label="Revenue" value={`$${totals.revenue.toLocaleString()}`} />
        <Tile label="Avg ticket" value={totals.avgTicket > 0 ? `$${totals.avgTicket}` : "n/a"} />
        <Tile label="Busiest day" value={busiest.weekday ?? "n/a"} />
      </motion.div>

      {/* Cuts per week */}
      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg">Cuts per week</h2>
            <div className="flex items-center gap-1 rounded-full border border-subtle p-0.5">
              {[8, 12, 26].map((w) => (
                <button
                  key={w}
                  onClick={() => setRange(w)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition-colors duration-150 ease-out",
                    range === w
                      ? "bg-gold/15 text-gold"
                      : "text-muted hover:text-offwhite",
                  )}
                >
                  {w}w
                </button>
              ))}
            </div>
          </div>
          <WeekBars weeks={weeks} pending={pending} />
        </Card>
      </motion.div>

      {/* What people book (and pay for) most */}
      <motion.div variants={fadeUp}>
        <Card className="overflow-hidden">
          <CardHeader
            title="Top services"
            subtitle="What clients book most - and what it brings in."
          />
          {services.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">
              No completed visits in this window yet.
            </p>
          ) : (
            <ServiceBars services={services} />
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeUp} className="grid gap-6 md:grid-cols-2">
        {/* Day-of-week shape */}
        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg">By day of week</h2>
          <DayBars counts={busiest.counts} />
        </Card>

        {/* Clients + loyalty in the window */}
        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg">Clients &amp; loyalty</h2>
          <dl className="flex flex-col gap-2.5 text-sm">
            <Row label="Clients seen" value={String(totals.uniqueClients)} />
            <Row label="New clients" value={String(totals.newClients)} emphasize />
            <Row label="Returning" value={String(totals.returningClients)} />
            {rewardsEnabled && (
              <Row label="Punches earned" value={String(loyalty.punchesEarned)} />
            )}
            {rewardsEnabled && (
              <Row label="Rewards redeemed" value={String(loyalty.redemptions)} />
            )}
          </dl>
        </Card>
      </motion.div>
    </motion.div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={cn("mt-1 font-display text-xl", accent ? "text-gold" : "text-offwhite")}>
        {value}
      </p>
    </Card>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn("font-medium", emphasize ? "text-gold" : "text-offwhite")}>{value}</dd>
    </div>
  );
}

/** Weekly grouped bars: visits (gold) with the revenue printed under the peak weeks. */
function WeekBars({
  weeks,
  pending,
}: {
  weeks: InsightsData["weeks"];
  pending: boolean;
}) {
  const max = Math.max(1, ...weeks.map((w) => w.visits));
  const hasData = weeks.some((w) => w.visits > 0);
  if (!hasData) {
    return (
      <p className="py-6 text-sm text-muted">
        No completed visits in this window yet - they&apos;ll chart here as they come in.
      </p>
    );
  }
  return (
    <div className={cn("transition-opacity duration-150 ease-out", pending && "opacity-50")}>
      <div className="flex h-36 items-end gap-1.5">
        {weeks.map((w, i) => (
          <div
            key={i}
            className="group relative flex-1"
            title={`${w.label}: ${w.visits} ${w.visits === 1 ? "visit" : "visits"}${
              w.revenue > 0 ? ` · $${w.revenue.toLocaleString()}` : ""
            }`}
          >
            <div
              className="w-full rounded-t bg-gold/70 transition-all duration-200 ease-out group-hover:bg-gold"
              style={{ height: `${Math.max(2, Math.round((w.visits / max) * 100))}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted">
        <span>{weeks[0]?.label}</span>
        <span>{weeks[weeks.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** Horizontal bars per service with a count/revenue toggle. */
function ServiceBars({ services }: { services: InsightsData["services"] }) {
  const [mode, setMode] = useState<"count" | "revenue">("count");
  const sorted = [...services].sort((a, b) => b[mode] - a[mode]);
  const max = Math.max(1, ...sorted.map((s) => s[mode]));
  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-center gap-1 rounded-full border border-subtle p-0.5 self-start w-fit">
        {(["count", "revenue"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded-full px-3 py-1 text-xs capitalize transition-colors duration-150 ease-out",
              mode === m ? "bg-gold/15 text-gold" : "text-muted hover:text-offwhite",
            )}
          >
            {m === "count" ? "By bookings" : "By revenue"}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-2.5">
        {sorted.map((s) => (
          <li key={s.name}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className={cn("truncate", s.name === "(no service)" ? "text-muted" : "text-offwhite")}>
                {s.name}
              </span>
              <span className="shrink-0 text-muted">
                {mode === "count"
                  ? `${s.count} ${s.count === 1 ? "booking" : "bookings"}`
                  : `$${s.revenue.toLocaleString()}`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-700">
              <div
                className="h-full rounded-full bg-gold/70 transition-all duration-200 ease-out"
                style={{ width: `${Math.max(2, Math.round((s[mode] / max) * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mon..Sun mini bars. */
function DayBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="flex h-28 items-end gap-2">
      {counts.map((c, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t bg-gold/70"
              style={{ height: `${Math.max(2, Math.round((c / max) * 100))}%` }}
              title={`${WEEKDAYS[i]}: ${c}`}
            />
          </div>
          <span className="text-[10px] text-muted">{WEEKDAYS[i]}</span>
        </div>
      ))}
    </div>
  );
}

//  Quota goal card

/** "$1,234" for revenue goals, "17 cuts" for visit goals. */
function fmtAmount(metric: GoalData["metric"], n: number): string {
  return metric === "revenue"
    ? `$${n.toLocaleString()}`
    : `${n.toLocaleString()} cut${n === 1 ? "" : "s"}`;
}

/**
 * The barber's quota: set a revenue or cut-count target for the week/month and
 * watch actual vs. straight-line PACE — the pace verdict is the point (a bare
 * progress bar always looks fine until the 28th). Progress derives from
 * COMPLETED visits server-side, so native and Acuity-synced shops read alike.
 */
function GoalCard({ initial }: { initial: GoalResponse | null }) {
  const [data, setData] = useState<GoalResponse | null>(initial);
  const [editing, setEditing] = useState(false);
  const [metric, setMetric] = useState<GoalData["metric"]>("revenue");
  const [period, setPeriod] = useState<GoalData["period"]>("month");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goal = data?.goal ?? null;
  const progress = data?.progress ?? null;

  function beginEdit() {
    setMetric(goal?.metric ?? "revenue");
    setPeriod(goal?.period ?? "month");
    setTarget(goal ? String(goal.target) : "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const n = Number(target.trim());
    if (!Number.isInteger(n) || n < 1) {
      setError("Target must be a whole number of at least 1.");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await saveGoalAction({ metric, period, target: n });
    if (r.ok) {
      setData(await goalAction());
      setEditing(false);
    } else {
      setError("Couldn't save the goal. Try again.");
    }
    setSaving(false);
  }

  async function clear() {
    if (!window.confirm("Remove your goal? Progress tracking stops (history is unaffected).")) {
      return;
    }
    setSaving(true);
    const r = await clearGoalAction();
    if (r.ok) setData(await goalAction());
    setSaving(false);
  }

  // ---- Setup / edit form ----
  // (progress rides along whenever a goal exists; the null-check keeps a
  // hypothetical partial response on the safe branch instead of crashing.)
  if (editing || !goal || !progress) {
    return (
      <Card className="p-5">
        <CardHeader
          title="Goal"
          subtitle="Set a quota for the week or month — revenue or completed cuts — and Insights tracks whether you're on pace."
        />
        {!editing ? (
          <button
            onClick={beginEdit}
            className="mt-3 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900"
          >
            Set a goal
          </button>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["revenue", "Revenue ($)"],
                  ["visits", "Completed cuts"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMetric(key)}
                  aria-pressed={metric === key}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    metric === key
                      ? "border-gold/60 bg-gold/10 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="mx-1 self-center text-xs text-muted">per</span>
              {(
                [
                  ["week", "Week"],
                  ["month", "Month"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPeriod(key)}
                  aria-pressed={period === key}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    period === key
                      ? "border-gold/60 bg-gold/10 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="block max-w-[220px]">
              <span className="text-xs uppercase tracking-wide text-muted">
                Target {metric === "revenue" ? "($)" : "(cuts)"}
              </span>
              <input
                className="mt-1 w-full rounded-xl border border-subtle bg-charcoal-800 px-3 py-2 text-sm"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder={metric === "revenue" ? "4000" : "60"}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label="Goal target"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-red-400">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-xl bg-gold px-5 py-2 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save goal"}
              </button>
              {goal && (
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-xl border border-subtle px-4 py-2 text-sm text-muted hover:text-offwhite"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </Card>
    );
  }

  // ---- Progress display ----
  const p = progress;
  const pctFill = Math.round(p.pct * 100);
  const onPace = p.delta >= 0;
  // Where the pace line sits along the bar (as % of TARGET, capped).
  const paceMark = Math.min(100, Math.round((p.paceTarget / goal.target) * 100));
  const periodLabel = goal.period === "week" ? "this week" : "this month";

  // Mini chart: cumulative actual vs the straight target line, in a 300x80 box.
  const W = 300;
  const H = 80;
  const padY = 6;
  const maxY = Math.max(goal.target, p.actual, 1);
  const px = (i: number) =>
    p.totalDays <= 1 ? W / 2 : (i / (p.totalDays - 1)) * W;
  const py = (v: number) => padY + (1 - v / maxY) * (H - padY * 2);
  const actualPath = p.series
    .filter((s): s is { day: number; cumulative: number } => s.cumulative !== null)
    .map((s) => `${px(s.day - 1)},${py(s.cumulative)}`)
    .join(" ");

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">
            Goal · {periodLabel}
          </p>
          <p className="mt-1 font-display text-2xl text-offwhite">
            {fmtAmount(goal.metric, p.actual)}
            <span className="text-base text-muted">
              {" "}
              of {fmtAmount(goal.metric, goal.target)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* The pace verdict — the whole point of the card. */}
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold",
              onPace
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-400",
            )}
          >
            {p.delta === 0
              ? "On pace"
              : onPace
                ? `Ahead by ${fmtAmount(goal.metric, p.delta)}`
                : `${fmtAmount(goal.metric, -p.delta)} behind pace`}
          </span>
          <button
            onClick={beginEdit}
            className="rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:text-offwhite"
          >
            Edit
          </button>
          <button
            onClick={clear}
            disabled={saving}
            className="rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:text-red-400"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Progress bar with the pace tick: fill = actual/target, tick = where
          the straight-line pace says you should be today. */}
      <div className="relative mt-4 h-3 overflow-hidden rounded-full bg-charcoal-700">
        <div
          className={cn("h-full rounded-full", onPace ? "bg-emerald-500/80" : "bg-gold/80")}
          style={{ width: `${pctFill}%` }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-offwhite/70"
          style={{ left: `${paceMark}%` }}
          title={`Pace: ${fmtAmount(goal.metric, p.paceTarget)} by today`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{pctFill}% of goal</span>
        <span>
          {p.daysLeft === 0
            ? "Last day"
            : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`}
        </span>
      </div>

      {/* Cumulative actual (solid) vs straight-line target (dashed). */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 h-[64px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Goal progress: ${fmtAmount(goal.metric, p.actual)} of ${fmtAmount(
          goal.metric,
          goal.target,
        )} ${periodLabel}, ${onPace ? "on or ahead of" : "behind"} pace`}
      >
        <line
          x1={px(0)}
          y1={py(0)}
          x2={px(p.totalDays - 1)}
          y2={py(goal.target)}
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={1}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        {actualPath && (
          <polyline
            points={actualPath}
            fill="none"
            stroke="#D4AF37"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted">
        <span>{p.periodStart.slice(5)}</span>
        <span>target: {fmtAmount(goal.metric, goal.target)}</span>
        <span>{p.periodEnd.slice(5)}</span>
      </div>
    </Card>
  );
}
