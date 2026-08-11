"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { pluralServiceNoun } from "@chairback/config/constants";
import { Card, CardHeader } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import { fmtDurationExact } from "@/lib/duration";
import { NumberField } from "@/components/ui/NumberField";
import { GoalPlanner } from "./GoalPlanner";
import { PeriodControl } from "./PeriodControl";
import type {
  Bucket,
  CustomRange,
  Goal,
  GoalMetric,
  GoalPeriod,
  GoalResponse,
  InsightsData,
  PeriodKey,
  PlannerData,
  ServiceGoalRow,
  UtilizationData,
} from "./page";
import {
  clearChairTimeGoalAction,
  clearGoalAction,
  goalAction,
  insightsAction,
  saveChairTimeGoalAction,
  saveGoalAction,
  utilizationAction,
} from "./actions";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "Aug 4" from a shop-local YYYY-MM-DD, without dragging it through local tz. */
function fmtDay(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "twists" -> "Twists" for labels; the noun is stored lowercase. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The barber's analytics page. Same dependency-free chart approach as
 * TrendsChart: scaled divs, no chart library.
 *
 * ONE period control at the top drives every card, and the API echoes the window
 * it measured with each response — so the titles, the axis and the numbers can
 * never describe different spans of time.
 */
export function InsightsClient({
  initial,
  initialGoalData = null,
  rewardsEnabled = true,
  serviceNoun = "cut",
}: {
  initial: InsightsData;
  initialGoalData?: GoalResponse | null;
  rewardsEnabled?: boolean;
  /** The shop's singular visit-noun ("cut"/"twist"), resolved by the API. */
  serviceNoun?: string;
}) {
  const nounPlural = pluralServiceNoun(serviceNoun);
  const [period, setPeriod] = useState<PeriodKey>(initial.period);
  // Goals + planner data live here because three cards read them: GoalsCard
  // (the four quota slots + planner sheet), Chair time (the % target) and
  // Services (per-service quotas). One fetch, one refresh, no drift.
  const [goalData, setGoalData] = useState<GoalResponse | null>(initialGoalData);
  async function refreshGoals() {
    const r = await goalAction();
    if (r) setGoalData(r);
  }
  // null = the period's default bar size; a click on the Day/Week/Month pills
  // overrides it. Reset on period change - a bucket that suits 30 days may not
  // exist for a year (the API would quietly fall back, but the pills should
  // never show a choice the response didn't honor).
  const [bucket, setBucket] = useState<Bucket | null>(null);
  // The custom date-to-date range: what's APPLIED (drives fetches). The draft
  // lives inside each PeriodControl instance so a half-typed range never fires.
  const [range, setRange] = useState<CustomRange | null>(null);
  // Keep showing the last good payload while the next one loads, so the page
  // dims rather than collapsing to empty every time the range changes.
  const [data, setData] = useState<InsightsData>(initial);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // Shared by both PeriodControl instances (page top + the Chair time chip) so
  // there is exactly ONE applied window however it was chosen.
  const selectPeriod = (p: PeriodKey) => {
    setPeriod(p);
    setBucket(null); // each range starts at its natural bar size
  };
  const applyRange = (r: CustomRange) => {
    setRange(r);
    setPeriod("custom");
    setBucket(null);
  };

  useEffect(() => {
    // Already showing this window at this bar size. A custom range compares on
    // its dates too - the key alone stays "custom" while the dates change.
    const sameWindow =
      period === data.period &&
      (bucket === null || bucket === data.bucket) &&
      (period !== "custom" ||
        (range !== null &&
          range.from === data.windowStart &&
          range.to === data.windowEnd));
    if (sameWindow) return;
    if (period === "custom" && !range) return; // nothing applied yet
    let cancelled = false;
    setPending(true);
    setFailed(false);
    void insightsAction(period, bucket ?? undefined, range ?? undefined).then((d) => {
      if (cancelled) return;
      if (d) setData(d);
      else setFailed(true);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [period, bucket, range, data.period, data.bucket, data.windowStart, data.windowEnd]);

  const { buckets, services, totals, busiest, loyalty } = data;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6"
    >
      {/* The one range control for the whole tab. */}
      <motion.div variants={fadeUp}>
        <PeriodControl
          periods={data.periods}
          period={period}
          periodLabel={data.periodLabel}
          windowStart={data.windowStart}
          windowEnd={data.windowEnd}
          onSelectPeriod={selectPeriod}
          onApplyRange={applyRange}
        />
        <p className="mt-2 text-[11px] text-muted">
          {fmtDay(data.windowStart)} – {fmtDay(data.windowEnd)} · every card below
          covers this range, in your shop&apos;s time.
          {pending && " Updating…"}
        </p>
        {failed && (
          <p role="alert" className="mt-1 text-[11px] text-amber-400">
            Couldn&apos;t load that range — still showing {data.periodLabel.toLowerCase()}.
          </p>
        )}
      </motion.div>

      {/* Goals — one target per metric AND period, each kept separately. */}
      <motion.div variants={fadeUp}>
        <GoalsCard
          goals={goalData?.goals ?? null}
          planner={goalData?.planner ?? null}
          onRefresh={refreshGoals}
          serviceNoun={serviceNoun}
        />
      </motion.div>

      {/* Headline numbers for the window */}
      <motion.div
        variants={fadeUp}
        className={cn(
          "grid grid-cols-2 gap-4 transition-opacity duration-150 ease-out sm:grid-cols-4",
          pending && "opacity-60",
        )}
      >
        <Tile label={cap(nounPlural)} value={String(totals.visits)} accent />
        <Tile label="Revenue" value={`$${totals.revenue.toLocaleString()}`} />
        <Tile
          label="Avg ticket"
          value={totals.avgTicket > 0 ? `$${totals.avgTicket}` : "n/a"}
          note={
            totals.unpricedCount > 0
              ? `${totals.pricedCount} priced of ${totals.visits}`
              : undefined
          }
        />
        <Tile label="Busiest day" value={busiest.weekday ?? "n/a"} />
      </motion.div>

      {/* Cuts over time — the bar is whatever the range makes it, and the
          Day/Week/Month pills re-slice the same range on demand. */}
      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-lg">
                {cap(nounPlural)} per {data.bucketNoun}
              </h2>
              <span className="text-xs text-muted">{data.periodLabel}</span>
            </div>
            {data.bucketOptions.length > 1 && (
              <Segmented
                options={data.bucketOptions.map((b) => ({
                  key: b,
                  label: b === "day" ? "Day" : b === "week" ? "Week" : "Month",
                }))}
                value={bucket ?? data.bucket}
                onChange={setBucket}
                ariaLabel="Bar size"
              />
            )}
          </div>
          <BucketBars
            buckets={buckets}
            pending={pending}
            noun={data.bucketNoun}
            serviceNoun={serviceNoun}
          />
        </Card>
      </motion.div>

      {/* What people book (and pay for) most */}
      <motion.div variants={fadeUp}>
        <Card className="overflow-hidden">
          <CardHeader
            title="Services"
            subtitle="What clients booked — and what it brought in. Your whole menu is here; anything at zero went unbooked this range."
          />
          {services.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">
              No services on the menu yet — add them under Booking → Services.
            </p>
          ) : (
            <ServiceBars
              services={services}
              pending={pending}
              serviceGoals={goalData?.serviceGoals ?? []}
              onRefreshGoals={refreshGoals}
              serviceNoun={serviceNoun}
            />
          )}
        </Card>
      </motion.div>

      {/* Open chair time vs sold chair time */}
      <motion.div variants={fadeUp}>
        <UtilizationCard
          period={period}
          bucket={bucket}
          range={range}
          chairTimeTarget={goalData?.chairTime.target ?? null}
          onRefreshGoals={refreshGoals}
          onSelectPeriod={selectPeriod}
          onApplyRange={applyRange}
        />
      </motion.div>

      <motion.div
        variants={fadeUp}
        className={cn(
          "grid gap-6 transition-opacity duration-150 ease-out md:grid-cols-2",
          pending && "opacity-60",
        )}
      >
        {/* Day-of-week shape. Titled "Cuts by day" - Chair time's weekday view
            is ALSO called "By day of week", and two cards with one name and two
            different measures (booking counts here, minutes there) read as the
            page contradicting itself. */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg">{cap(nounPlural)} by day</h2>
          <p className="mb-4 text-xs text-muted">
            Every {serviceNoun} in this range, stacked onto the day it fell on.
          </p>
          <DayBars counts={busiest.counts} />
        </Card>

        {/* Clients + loyalty in the window */}
        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg">Clients &amp; loyalty</h2>
          <dl className="flex flex-col gap-2.5 text-sm">
            <Row label="Clients seen" value={String(totals.uniqueClients)} />
            <Row label="New clients" value={String(totals.newClients)} emphasize />
            <Row label="Returning" value={String(totals.returningClients)} />
            {totals.walkIns > 0 && (
              <Row label="Walk-ins (no client)" value={String(totals.walkIns)} />
            )}
            {rewardsEnabled && (
              <Row label="Punches earned" value={String(loyalty.punchesEarned)} />
            )}
            {rewardsEnabled && (
              <Row label="Rewards redeemed" value={String(loyalty.redemptions)} />
            )}
          </dl>
          {totals.walkIns > 0 && (
            <p className="mt-3 text-[11px] text-muted/80">
              Walk-ins booked without a client record count as {nounPlural} and
              revenue, but there&apos;s no person to count them against — which
              is why {nounPlural} can run ahead of clients seen.
            </p>
          )}
        </Card>
      </motion.div>
    </motion.div>
  );
}

function Tile({
  label,
  value,
  accent,
  note,
}: {
  label: string;
  value: string;
  accent?: boolean;
  note?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          "mt-1 font-display text-xl tabular-nums",
          accent ? "text-gold" : "text-offwhite",
        )}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-[10px] text-muted">{note}</p>}
    </Card>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn("font-medium tabular-nums", emphasize ? "text-gold" : "text-offwhite")}>
        {value}
      </dd>
    </div>
  );
}

/** Bars per bucket — a day, a week or a month, whichever the range selected. */
function BucketBars({
  buckets,
  pending,
  noun,
  serviceNoun,
}: {
  buckets: InsightsData["buckets"];
  pending: boolean;
  noun: string;
  serviceNoun: string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.cuts));
  const hasData = buckets.some((b) => b.cuts > 0);
  const nounPlural = pluralServiceNoun(serviceNoun);
  // The count under each bar, when the bars are wide enough to carry one: a
  // 30-bar day view on a phone has no room, so dense views keep the tooltip.
  const showCounts = buckets.length <= 16;
  if (!hasData) {
    return (
      <p className="py-6 text-sm text-muted">
        No bookings in this range yet — they&apos;ll chart here as they come in.
        Try a longer range if you&apos;re just getting started.
      </p>
    );
  }
  return (
    <div className={cn("transition-opacity duration-150 ease-out", pending && "opacity-50")}>
      {/* Each column must STRETCH to the track's height: a percentage height
          resolves against a definite parent only, so `items-end` on the column
          would collapse it to auto and render an empty chart. The column is a
          flex-col whose TRACK stretches (like DayBars); the bar sits at the
          track's bottom, with the count label under it. */}
      <div
        className={cn("flex gap-1", showCounts ? "h-40" : "h-36")}
        role="img"
        aria-label={`${cap(nounPlural)} per ${noun}`}
      >
        {buckets.map((b) => (
          <div
            key={b.key}
            className="group relative flex flex-1 flex-col"
            title={`${b.fullLabel}: ${b.cuts} ${b.cuts === 1 ? serviceNoun : nounPlural}${
              b.revenue > 0 ? ` · $${b.revenue.toLocaleString()}` : ""
            }`}
          >
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t bg-gold/70 transition-all duration-200 ease-out group-hover:bg-gold"
                style={{ height: `${Math.max(2, Math.round((b.cuts / max) * 100))}%` }}
              />
            </div>
            {showCounts && (
              <span
                className={cn(
                  "mt-1 text-center text-[10px] tabular-nums",
                  b.cuts > 0 ? "text-muted" : "text-muted/50",
                )}
              >
                {b.cuts}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/**
 * Horizontal bars per service with a count/revenue toggle.
 *
 * The list is the WHOLE menu, booked first. Unbooked services are folded behind
 * a toggle so a long menu doesn't bury the ranking — but they are reachable,
 * because "my service isn't in here" is indistinguishable from "it's broken".
 */
function ServiceBars({
  services,
  pending,
  serviceGoals,
  onRefreshGoals,
  serviceNoun,
}: {
  services: InsightsData["services"];
  pending: boolean;
  serviceGoals: ServiceGoalRow[];
  onRefreshGoals: () => Promise<void>;
  serviceNoun: string;
}) {
  const nounPlural = pluralServiceNoun(serviceNoun);
  const [mode, setMode] = useState<"count" | "revenue">("count");
  const [showAll, setShowAll] = useState(false);
  // Per-service quota editor: which row is open, and its draft.
  const [goalEditor, setGoalEditor] = useState<string | null>(null); // serviceId
  const [goalTarget, setGoalTarget] = useState<number>(10);
  const [goalPeriod, setGoalPeriod] = useState<GoalPeriod>("week");
  const [goalSaving, setGoalSaving] = useState(false);

  // The metric a row's quota uses follows the card's toggle: ranking by
  // bookings sets cut quotas, ranking by revenue sets dollar quotas.
  const goalMetric: GoalMetric = mode === "count" ? "visits" : "revenue";
  const goalFor = (serviceId: string | null): ServiceGoalRow | undefined =>
    serviceId
      ? serviceGoals.find((g) => g.serviceId === serviceId && g.metric === goalMetric)
      : undefined;

  function openGoalEditor(serviceId: string) {
    const existing = goalFor(serviceId);
    setGoalTarget(existing?.target ?? (goalMetric === "visits" ? 10 : 500));
    setGoalPeriod(existing?.period ?? "week");
    setGoalEditor(serviceId);
  }

  async function saveServiceGoal(serviceId: string) {
    setGoalSaving(true);
    const r = await saveGoalAction({
      metric: goalMetric,
      period: goalPeriod,
      target: goalTarget,
      serviceId,
    });
    if (r.ok) {
      await onRefreshGoals();
      setGoalEditor(null);
    }
    setGoalSaving(false);
  }

  async function removeServiceGoal(g: ServiceGoalRow) {
    setGoalSaving(true);
    const r = await clearGoalAction({
      metric: g.metric,
      period: g.period,
      serviceId: g.serviceId,
    });
    if (r.ok) {
      await onRefreshGoals();
      setGoalEditor(null);
    }
    setGoalSaving(false);
  }

  const booked = services.filter((s) => s.count > 0);
  const unbooked = services.filter((s) => s.count === 0);
  const ranked = [...booked].sort((a, b) => b[mode] - a[mode] || b.count - a.count);
  const TOP = 10;
  const visible = showAll ? [...ranked, ...unbooked] : ranked.slice(0, TOP);
  const hidden = booked.length - Math.min(TOP, booked.length) + unbooked.length;
  const max = Math.max(1, ...ranked.map((s) => s[mode]));

  return (
    <div className={cn("px-5 py-4", pending && "opacity-50")}>
      <Segmented
        className="mb-3"
        options={[
          { key: "count", label: "By bookings" },
          { key: "revenue", label: "By revenue" },
        ]}
        value={mode}
        onChange={setMode}
        ariaLabel="Rank services by"
      />
      {booked.length === 0 && (
        <p className="mb-3 text-sm text-muted">
          Nothing booked in this range — your menu is listed below at zero.
        </p>
      )}
      <ul className="flex flex-col gap-2.5">
        {visible.map((s) => {
          const g = goalFor(s.serviceId);
          const editingThis = goalEditor !== null && goalEditor === s.serviceId;
          return (
            <li key={s.serviceId ?? `name:${s.name}`}>
              <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "truncate",
                      s.count === 0 || s.name === "(no service name)"
                        ? "text-muted"
                        : "text-offwhite",
                    )}
                    title={s.name}
                  >
                    {s.name}
                  </span>
                  {s.serviceId && (
                    <button
                      type="button"
                      onClick={() =>
                        editingThis ? setGoalEditor(null) : openGoalEditor(s.serviceId!)
                      }
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] tabular-nums transition-colors",
                        g
                          ? g.pct >= 1
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                            : "border-gold/40 bg-gold/10 text-gold"
                          : "border-subtle text-muted hover:border-gold/50 hover:text-gold",
                      )}
                      title={
                        g
                          ? `${g.actual} of ${g.target} ${g.metric === "visits" ? nounPlural : "$"} ${PERIOD_LABEL[g.period]}`
                          : "Set a target for this service"
                      }
                    >
                      {g
                        ? `${g.actual}/${g.target}${g.period === "week" ? " wk" : " mo"}`
                        : "+ target"}
                    </button>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-muted">
                  {mode === "count"
                    ? `${s.count} ${s.count === 1 ? "booking" : "bookings"}`
                    : `$${s.revenue.toLocaleString()}`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-700">
                <div
                  className="h-full rounded-full bg-gold/70 transition-all duration-200 ease-out"
                  style={{ width: `${Math.max(s[mode] > 0 ? 2 : 0, Math.round((s[mode] / max) * 100))}%` }}
                />
              </div>
              {editingThis && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-charcoal-800/50 px-3 py-2">
                  <NumberField
                    value={goalTarget}
                    onChange={setGoalTarget}
                    min={1}
                    max={1_000_000}
                    integer
                    className="w-20 rounded-lg border border-subtle bg-charcoal-800 px-2 py-1 text-right text-xs tabular-nums"
                    aria-label={`${goalMetric === "visits" ? cap(nounPlural) : "Revenue"} target for ${s.name}`}
                  />
                  <span className="text-[11px] text-muted">
                    {goalMetric === "visits" ? nounPlural : "$"} per
                  </span>
                  <Segmented
                    options={[
                      { key: "week", label: "week" },
                      { key: "month", label: "month" },
                    ]}
                    value={goalPeriod}
                    onChange={setGoalPeriod}
                    ariaLabel="Quota period"
                  />
                  <div className="ml-auto flex gap-1.5">
                    {g && (
                      <button
                        onClick={() => void removeServiceGoal(g)}
                        disabled={goalSaving}
                        className="rounded-full border border-subtle px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                    <button
                      onClick={() => void saveServiceGoal(s.serviceId!)}
                      disabled={goalSaving}
                      className="rounded-full bg-gold px-3 py-1 text-[11px] font-semibold text-charcoal-900 disabled:opacity-50"
                    >
                      {goalSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-xs text-muted underline-offset-2 transition-colors hover:text-offwhite hover:underline"
        >
          {showAll
            ? "Show top 10 only"
            : `Show all ${booked.length + unbooked.length} services${
                unbooked.length > 0 ? ` (${unbooked.length} unbooked)` : ""
              }`}
        </button>
      )}
    </div>
  );
}

//  Chair utilization

/**
 * Chair time's period pills. "How full was my chair" is asked about this week
 * or this month; the quarter/half/year presets on the page top are a trends
 * question, and five pills wrap in the compact chip. Anything else is Custom.
 * "Month" labels the rolling 30-day window - shorter than "Last 30 days", and
 * the card's own header states the exact dates.
 */
const CHAIR_TIME_PRESETS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "Month" },
] as const satisfies readonly { key: PeriodKey; label: string }[];

/** "6h 30m" / "45m" — hours read better than 390 minutes to a barber. */
// Chair time is compared against itself all over this card (sold vs open, and
// each weekday row's pair), so it uses the spell-it-out variant - see
// lib/duration.ts. Hours roll into days at 24 there: a month-long window holds
// hundreds of hours, and "202h 56m" is arithmetic nobody can picture. The
// per-weekday rows never exceed a day, so they keep their "8h 0m" shape.

/**
 * Color the bar by how full it is — red/amber/green reads at a glance. A null
 * percentage (work booked outside any scheduled hours) must still be VISIBLE:
 * the old charcoal-600 painted on the charcoal-700 track was a bar you could
 * not see, so every off-hours weekday looked like an empty row.
 */
function utilTone(pct: number | null): string {
  if (pct === null) return "bg-amber-400/60";
  if (pct >= 75) return "bg-emerald-soft";
  if (pct >= 40) return "bg-gold";
  return "bg-rose-400/80";
}

const UTIL_VIEWS = [
  { key: "weekday", label: "By day of week" },
  { key: "period", label: "Over time" },
  { key: "service", label: "By service" },
] as const;

/**
 * How much of the time the barber was OPEN actually got sold.
 *
 * "Busiest day" counts bookings, which can't tell a full Saturday from a barely
 * worked Wednesday — this can. Customizable along the axes a barber actually
 * thinks in: which weekday runs empty, whether it's trending up or down over the
 * selected range, or what fills the chair. Range follows the page's one control.
 */
function UtilizationCard({
  period,
  bucket,
  range,
  chairTimeTarget,
  onRefreshGoals,
  onSelectPeriod,
  onApplyRange,
}: {
  period: PeriodKey;
  bucket: Bucket | null;
  range: CustomRange | null;
  chairTimeTarget: number | null;
  onRefreshGoals: () => Promise<void>;
  // The page-level period setters: the card's chip opens the SAME control the
  // page top has, so however the range is chosen there is one applied window.
  onSelectPeriod: (p: PeriodKey) => void;
  onApplyRange: (r: CustomRange) => void;
}) {
  const [by, setBy] = useState<"weekday" | "period" | "service">("weekday");
  const [staffId, setStaffId] = useState<string>("");
  // "" = all services, "s:<id>" = one service, "g:<id>" = one group.
  const [svcFilter, setSvcFilter] = useState<string>("");
  const [periodOpen, setPeriodOpen] = useState(false);
  const [data, setData] = useState<UtilizationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The standing "run at N% booked" target editor.
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState<number>(chairTimeTarget ?? 75);
  const [savingTarget, setSavingTarget] = useState(false);

  async function saveTarget() {
    setSavingTarget(true);
    const r = await saveChairTimeGoalAction(targetDraft);
    if (r.ok) {
      await onRefreshGoals();
      setEditingTarget(false);
    }
    setSavingTarget(false);
  }

  async function clearTarget() {
    setSavingTarget(true);
    const r = await clearChairTimeGoalAction();
    if (r.ok) {
      await onRefreshGoals();
      setEditingTarget(false);
    }
    setSavingTarget(false);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void utilizationAction({
      period,
      by,
      // Follow the page's bar-size override so "Over time" re-buckets in step
      // with the cuts chart instead of contradicting it.
      ...(bucket ? { bucket } : {}),
      ...(range ? { range } : {}),
      ...(staffId ? { staffId } : {}),
      ...(svcFilter.startsWith("s:") ? { serviceId: svcFilter.slice(2) } : {}),
      ...(svcFilter.startsWith("g:") ? { groupId: svcFilter.slice(2) } : {}),
    }).then((d) => {
      if (cancelled) return;
      if (d) setData(d);
      else setFailed(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // range is an object: depend on its DATES, not its identity, or every
    // parent render would refetch this card.
  }, [period, bucket, range?.from, range?.to, by, staffId, svcFilter]);

  const rawRows = data?.rows ?? [];
  // Weekday rows accumulate the WHOLE window - at a year that's "210h / 470h",
  // 52 Mondays summed, which answers nothing. The API sends how many of each
  // weekday the window held (r.days); showing the per-weekday AVERAGE is what
  // makes "which day runs empty?" readable. The percentage is a ratio, so it
  // survives the division untouched.
  const rows = rawRows.map((r) =>
    by === "weekday" && r.days > 0
      ? { ...r, openMin: Math.round(r.openMin / r.days), bookedMin: Math.round(r.bookedMin / r.days) }
      : r,
  );
  // Scale bars to the busiest row, not to 100%: a shop that never exceeds 40%
  // would otherwise render seven near-invisible slivers.
  const maxBooked = Math.max(1, ...rows.map((r) => r.bookedMin));
  const maxOpen = Math.max(1, ...rows.map((r) => r.openMin));
  const scale = Math.max(maxBooked, maxOpen);
  // Weekday and over-time rows carry real capacity; service rows share one chair.
  const hasCapacity = by !== "service";
  // "over 4 Mondays" context for the weekday view's caption.
  const weekdaySpan = by === "weekday" ? Math.max(...rawRows.map((r) => r.days), 0) : 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Chair time"
        subtitle={`How much of the time you were open actually got booked${
          data ? ` — ${data.periodLabel.toLowerCase()}` : ""
        }.`}
        action={
          <button
            type="button"
            onClick={() => {
              setTargetDraft(chairTimeTarget ?? 75);
              setEditingTarget((v) => !v);
            }}
            className="rounded-full border border-gold/50 px-3 py-1 text-xs text-gold transition-colors hover:bg-gold/10"
          >
            {chairTimeTarget === null ? "Set a target" : "Edit target"}
          </button>
        }
      />
      <div className="flex flex-col gap-4 px-5 py-5">
        {editingTarget && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/40 bg-charcoal-800/50 px-4 py-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              I want to run at
              <NumberField
                value={targetDraft}
                onChange={setTargetDraft}
                min={1}
                max={100}
                integer
                className="w-16 rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-right text-sm tabular-nums"
                aria-label="Chair time target percent"
              />
              % booked
            </label>
            <div className="ml-auto flex gap-2">
              {chairTimeTarget !== null && (
                <button
                  onClick={() => void clearTarget()}
                  disabled={savingTarget}
                  className="rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:text-red-400"
                >
                  Remove
                </button>
              )}
              <button
                onClick={() => setEditingTarget(false)}
                className="rounded-full border border-subtle px-3 py-1 text-xs text-muted hover:text-offwhite"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveTarget()}
                disabled={savingTarget}
                className="rounded-full bg-gold px-3 py-1 text-xs font-semibold text-charcoal-900 disabled:opacity-50"
              >
                {savingTarget ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
        {/* Controls: the range (same control as the page top), how to slice it,
            which service fills it, and (multi-chair shops) whose chair. */}
        <div className="flex flex-wrap items-center gap-2">
          {data && (
            <button
              type="button"
              onClick={() => setPeriodOpen((v) => !v)}
              aria-expanded={periodOpen}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-150 ease-out",
                periodOpen
                  ? "border-gold/60 bg-gold/15 text-gold"
                  : "border-subtle text-muted hover:text-offwhite",
              )}
            >
              {data.periodLabel} ▾
            </button>
          )}
          <Segmented
            options={UTIL_VIEWS.map((v) => ({ key: v.key, label: v.label }))}
            value={by}
            onChange={setBy}
            ariaLabel="Group by"
          />
          <div className="ml-auto flex items-center gap-2">
            {data &&
              (data.serviceOptions.length > 0 || data.groups.length > 0) && (
                <select
                  value={svcFilter}
                  onChange={(e) => setSvcFilter(e.target.value)}
                  aria-label="Service"
                  className="max-w-[11rem] rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
                >
                  <option value="">All services</option>
                  {data.groups.length > 0 && (
                    <optgroup label="Groups">
                      {data.groups.map((g) => (
                        <option key={g.id} value={`g:${g.id}`}>
                          {g.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Services">
                    {data.serviceOptions.map((s) => (
                      <option key={s.id} value={`s:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              )}
            {(data?.staff.length ?? 0) > 1 && (
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                aria-label="Barber"
                className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
              >
                <option value="">All barbers</option>
                {data!.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        {/* The SAME period control as the page top, right where Drick looks for
            it. It drives the page-level state, so the whole tab moves in step -
            but offers the short list: chair time is a "this week / this month"
            question, and five presets in a compact chip is a scroll. */}
        {periodOpen && data && (
          <PeriodControl
            compact
            presets={CHAIR_TIME_PRESETS}
            periods={data.periods}
            period={period}
            periodLabel={data.periodLabel}
            windowStart={data.windowStart}
            windowEnd={data.windowEnd}
            onSelectPeriod={(p) => {
              setPeriodOpen(false);
              onSelectPeriod(p);
            }}
            onApplyRange={(r) => {
              setPeriodOpen(false);
              onApplyRange(r);
            }}
          />
        )}

        {loading && !data ? (
          <p className="py-4 text-sm text-muted">Working out your chair time…</p>
        ) : failed && !data ? (
          <p className="py-4 text-sm text-muted" role="alert">
            Couldn&apos;t load chair time right now.
          </p>
        ) : data && data.noSchedule ? (
          <p className="py-4 text-sm text-muted">
            Set your weekly hours under Booking → Staff and this fills in — we
            need to know when you&apos;re open before we can say how full you are.
          </p>
        ) : (
          <>
            {/* The headline number, measured against the standing target. */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-3xl tabular-nums text-offwhite">
                {data?.totals.utilizationPct ?? 0}%
              </span>
              <span className="text-sm text-muted">
                of your open time booked ·{" "}
                <span className="tabular-nums">
                  {fmtDurationExact(data?.totals.bookedMin ?? 0)}
                </span>{" "}
                sold of{" "}
                <span className="tabular-nums">
                  {fmtDurationExact(data?.totals.openMin ?? 0)}
                </span>{" "}
                open
              </span>
              {chairTimeTarget !== null && (
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
                    (data?.totals.utilizationPct ?? 0) >= chairTimeTarget
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-400",
                  )}
                  title={`Your standing target: run at ${chairTimeTarget}% booked.`}
                >
                  target {chairTimeTarget}%
                </span>
              )}
            </div>

            <div className={cn("flex flex-col gap-2.5", loading && "opacity-50")}>
              {rows.length === 0 && (
                <p className="text-sm text-muted">Nothing booked in this range yet.</p>
              )}
              {rows.map((r) => {
                // Capacity views show sold-vs-open (a filled track inside the
                // period's capacity). Service rows share one chair, so they show
                // sold time only, scaled against the biggest service.
                const openW = Math.round((r.openMin / scale) * 100);
                const bookedW = Math.round((r.bookedMin / scale) * 100);
                // No hours scheduled AND nothing booked = a closed day.
                const closed = hasCapacity && r.openMin === 0 && r.bookedMin === 0;
                // No hours scheduled but work happened anyway: a cut squeezed in
                // outside the weekly schedule. There's no capacity to divide by,
                // so show the time sold rather than a "0%" that reads as a bad
                // day — or a "closed" that hides the work entirely.
                const offSchedule = hasCapacity && r.openMin === 0 && r.bookedMin > 0;
                return (
                  <div key={r.key} className="flex items-center gap-3">
                    <span
                      className="w-24 shrink-0 truncate text-xs text-muted sm:w-32"
                      title={r.label}
                    >
                      {r.label}
                    </span>
                    <div className="relative h-5 flex-1 overflow-hidden rounded bg-charcoal-700/60">
                      {hasCapacity && (
                        <div
                          className="absolute inset-y-0 left-0 rounded bg-charcoal-600/70"
                          style={{ width: `${openW}%` }}
                          aria-hidden
                        />
                      )}
                      <div
                        className={cn("absolute inset-y-0 left-0 rounded", utilTone(r.utilizationPct))}
                        style={{ width: `${bookedW}%` }}
                        aria-hidden
                      />
                    </div>
                    <span className="w-32 shrink-0 text-right text-xs tabular-nums text-muted">
                      {closed ? (
                        "closed"
                      ) : offSchedule ? (
                        <span title="Booked outside your weekly hours — there's no scheduled capacity to measure it against. Add this day to your hours and it gets a real percentage.">
                          <span className="text-offwhite">{fmtDurationExact(r.bookedMin)}</span>{" "}
                          <span className="text-amber-400/90">off-hours</span>
                        </span>
                      ) : (
                        <>
                          <span className="text-offwhite">{r.utilizationPct ?? 0}%</span>
                          {" · "}
                          {fmtDurationExact(r.bookedMin)}
                          {hasCapacity && ` / ${fmtDurationExact(r.openMin)}`}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-1 text-[11px] text-muted/80">
              {data?.serviceFilter && (
                <p>
                  Showing {data.serviceFilter.label ?? "the selected service"}{" "}
                  only — the % is its share of your total open time.
                </p>
              )}
              {by === "weekday" && weekdaySpan > 1 && (
                <p>
                  Each row is the average for that weekday across the range
                  (about {weekdaySpan} of each) — not the total, so a year and a
                  week read on the same scale.
                </p>
              )}
              <p>
                {by === "service"
                  ? "Share of your open time each service filled. Services share one chair, so these add up to your total booked time."
                  : "Open time comes from your current weekly hours, minus block-offs. Today counts only the hours already past, so checking before lunch doesn't read as a slump."}
              </p>
              {data?.syncedExcluded ? (
                <p>
                  One barber selected — Acuity and Square bookings aren&apos;t
                  tied to a barber, so this view shows their native bookings only.
                </p>
              ) : (
                <p>
                  Bookings made on Acuity or Square count too — they take up the
                  chair.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function DayBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    // Columns stretch to the full track height (see BucketBars) so the bars'
    // percentage heights have a definite parent to resolve against.
    <div className="flex h-28 gap-2">
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

//  Quota goals

/** "$1,234" for revenue goals, "17 cuts"/"17 twists" for count goals. */
function fmtAmount(metric: GoalMetric, n: number, noun: string): string {
  return metric === "revenue"
    ? `$${n.toLocaleString()}`
    : `${n.toLocaleString()} ${n === 1 ? noun : pluralServiceNoun(noun)}`;
}

/** "Revenue" / "Completed cuts" (or the shop's own word for a cut). */
function metricLabel(metric: GoalMetric, noun: string): string {
  return metric === "revenue" ? "Revenue" : `Completed ${pluralServiceNoun(noun)}`;
}

const PERIOD_LABEL: Record<GoalPeriod, string> = {
  week: "this week",
  month: "this month",
};

function goalKey(g: { metric: GoalMetric; period: GoalPeriod }): string {
  return `${g.metric}:${g.period}`;
}

/**
 * The barber's quotas. Four independent targets — revenue or cuts, per week or
 * per month — each SAVED SEPARATELY, because they are different goals: setting a
 * monthly revenue number must not wipe the weekly cut count he set yesterday.
 *
 * Every set goal shows actual vs straight-line PACE, which is the point (a bare
 * progress bar always looks fine until the 28th). All four cells share one
 * layout so the numbers line up down the column instead of wandering with the
 * length of each label.
 */
function GoalsCard({
  goals,
  planner,
  onRefresh,
  serviceNoun,
}: {
  goals: Goal[] | null;
  planner: PlannerData | null;
  onRefresh: () => Promise<void>;
  serviceNoun: string;
}) {
  const [planning, setPlanning] = useState<string | null>(null); // goalKey
  const [saving, setSaving] = useState(false);
  const nounPlural = pluralServiceNoun(serviceNoun);

  async function clear(g: Goal) {
    if (
      !window.confirm(
        `Remove your ${metricLabel(g.metric, serviceNoun).toLowerCase()} ${g.period} goal? Your other goals are unaffected.`,
      )
    ) {
      return;
    }
    setSaving(true);
    const r = await clearGoalAction({ metric: g.metric, period: g.period });
    if (r.ok) await onRefresh();
    setSaving(false);
  }

  if (!goals) {
    return (
      <Card className="p-5">
        <CardHeader title="Goals" subtitle="Couldn't load your goals right now." />
      </Card>
    );
  }

  const anySet = goals.some((g) => g.target !== null);
  const planningGoal = goals.find((g) => goalKey(g) === planning) ?? null;

  return (
    <Card className="p-5">
      <CardHeader
        title="Goals"
        subtitle={`Set a quota for the week and the month — then plan how to hit it: raise a price, add ${nounPlural}, pick how booked you want to run.`}
      />
      {!anySet && (
        <p className="mt-3 text-sm text-muted">
          Nothing set yet. Pick any of the four below and Insights tracks whether
          you&apos;re on pace — and helps you plan the prices and volume to get
          there.
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {goals.map((g) => (
          <GoalCell
            key={goalKey(g)}
            goal={g}
            saving={saving}
            serviceNoun={serviceNoun}
            onBeginEdit={() => setPlanning(goalKey(g))}
            onClear={() => void clear(g)}
          />
        ))}
      </div>
      {planningGoal && planner && (
        <GoalPlanner
          goal={planningGoal}
          planner={planner}
          serviceNoun={serviceNoun}
          onSaved={onRefresh}
          onClose={() => setPlanning(null)}
        />
      )}
    </Card>
  );
}

/**
 * One goal slot. Set or unset, every cell keeps the SAME internal rows in the
 * same order and at the same widths, so the four line up as a grid rather than
 * as four differently-shaped cards.
 */
function GoalCell({
  goal,
  saving,
  serviceNoun,
  onBeginEdit,
  onClear,
}: {
  goal: Goal;
  saving: boolean;
  serviceNoun: string;
  onBeginEdit: () => void;
  onClear: () => void;
}) {
  const title = `${metricLabel(goal.metric, serviceNoun)} · ${PERIOD_LABEL[goal.period]}`;
  const p = goal.progress;

  if (goal.target === null || !p) {
    return (
      <div className="flex flex-col rounded-xl border border-subtle p-4">
        <p className="text-[11px] uppercase tracking-wide text-muted">{title}</p>
        <p className="mt-1 font-display text-xl text-muted/60">Not set</p>
        <div className="mt-auto pt-3">
          <button
            onClick={onBeginEdit}
            className="rounded-full border border-gold/50 px-3 py-1 text-xs text-gold transition-colors hover:bg-gold/10"
          >
            Set a target
          </button>
        </div>
      </div>
    );
  }

  const pctFill = Math.round(p.pct * 100);
  const onPace = p.delta >= 0;
  // Where the pace line sits along the bar (as % of TARGET, capped).
  const paceMark = Math.min(100, Math.round((p.paceTarget / goal.target) * 100));

  return (
    <div className="flex flex-col rounded-xl border border-subtle p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-muted">{title}</p>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            onPace
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400",
          )}
        >
          {p.delta === 0
            ? "On pace"
            : onPace
              ? `+${fmtAmount(goal.metric, p.delta, serviceNoun)}`
              : `-${fmtAmount(goal.metric, -p.delta, serviceNoun)}`}
        </span>
      </div>

      <p className="mt-1 font-display text-2xl tabular-nums text-offwhite">
        {fmtAmount(goal.metric, p.actual, serviceNoun)}
        <span className="text-sm text-muted">
          {" "}
          of {fmtAmount(goal.metric, goal.target, serviceNoun)}
        </span>
      </p>

      {/* Progress bar with the pace tick: fill = actual/target, tick = where the
          straight-line pace says you should be today. */}
      <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-charcoal-700">
        <div
          className={cn("h-full rounded-full", onPace ? "bg-emerald-500/80" : "bg-gold/80")}
          style={{ width: `${pctFill}%` }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-offwhite/70"
          style={{ left: `${paceMark}%` }}
          title={`Pace: ${fmtAmount(goal.metric, p.paceTarget, serviceNoun)} by today`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted">
        <span>{pctFill}% of goal</span>
        <span>
          {p.daysLeft === 0 ? "Last day" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`}
        </span>
      </div>

      {goal.plan && (
        <p className="mt-2 text-[11px] text-muted">
          <span className="text-gold/90">Plan:</span> run at {goal.plan.bookedPct}%
          booked
          {goal.plan.services.length > 0 &&
            ` · ${goal.plan.services.length} service ${
              goal.plan.services.length === 1 ? "lever" : "levers"
            }`}
        </p>
      )}

      <div className="mt-auto flex gap-2 pt-3">
        <button
          onClick={onBeginEdit}
          className="rounded-full border border-gold/50 px-3 py-1 text-xs text-gold transition-colors hover:bg-gold/10"
        >
          Edit &amp; plan
        </button>
        <button
          onClick={onClear}
          disabled={saving}
          className="rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:text-red-400"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
