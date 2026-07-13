"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardHeader } from "@/components/ui/Card";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import type { InsightsData } from "./page";
import { insightsAction } from "./actions";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The barber's analytics page. Same dependency-free chart approach as
 * TrendsChart: scaled divs, no chart library. The default (12w) range renders
 * the server prop; other ranges re-fetch and never go stale.
 */
export function InsightsClient({
  initial,
  rewardsEnabled = true,
}: {
  initial: InsightsData;
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
