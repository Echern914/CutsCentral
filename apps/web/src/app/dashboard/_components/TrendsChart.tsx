"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp } from "@/components/motion/variants";
import { trendsAction } from "../actions";

export interface TrendPoint {
  label: string;
  visits: number;
  nudges: number;
}

/**
 * Lightweight dependency-free bar chart: completed visits vs nudges sent over a
 * selectable range (3/6/12 months). Grouped bars per month, scaled to the max.
 *
 * The default (6m) range always renders the server prop, so revalidations after
 * sweeps/nudges show up immediately; other ranges re-fetch whenever the server
 * data refreshes so they never go stale either.
 */
export function TrendsChart({ series: initial }: { series: TrendPoint[] }) {
  const [range, setRange] = useState(6);
  const [override, setOverride] = useState<TrendPoint[] | null>(null);
  const [pending, setPending] = useState(false);
  const series = range === 6 ? initial : (override ?? initial);

  useEffect(() => {
    if (range === 6) {
      setOverride(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    void trendsAction(range).then((s) => {
      if (cancelled) return;
      setOverride(s);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [range, initial]);

  function pick(months: number) {
    if (months !== range) setRange(months);
  }

  const max = Math.max(1, ...series.flatMap((p) => [p.visits, p.nudges]));
  const hasData = series.some((p) => p.visits > 0 || p.nudges > 0);

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg">Trends</h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-full border border-subtle p-0.5">
              {[3, 6, 12].map((m) => (
                <button
                  key={m}
                  onClick={() => pick(m)}
                  disabled={pending}
                  className={`rounded-full px-2.5 py-1 text-xs ${
                    range === m ? "bg-gold text-charcoal" : "text-muted hover:text-offwhite"
                  }`}
                >
                  {m}m
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-gold" /> Visits
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-muted" /> Nudges
              </span>
            </div>
          </div>
        </div>

        {!hasData ? (
          <p className="py-8 text-center text-sm text-muted">
            No activity yet. Charts fill in as visits and nudges accrue.
          </p>
        ) : (
          <div className="flex h-40 items-end justify-between gap-2">
            {series.map((p) => (
              <div key={p.label} className="flex flex-1 flex-col items-center gap-2">
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <Bar value={p.visits} max={max} className="bg-gold" title={`${p.visits} visits`} />
                  <Bar value={p.nudges} max={max} className="bg-muted" title={`${p.nudges} nudges`} />
                </div>
                <span className="text-[10px] uppercase tracking-wide text-muted">
                  {p.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </motion.div>
  );
}

function Bar({
  value,
  max,
  className,
  title,
}: {
  value: number;
  max: number;
  className: string;
  title: string;
}) {
  const pct = Math.round((value / max) * 100);
  return (
    <motion.div
      title={title}
      initial={{ height: 0 }}
      animate={{ height: `${Math.max(value > 0 ? 4 : 0, pct)}%` }}
      transition={{ type: "spring", stiffness: 120, damping: 18 }}
      className={`w-3 rounded-t ${className}`}
    />
  );
}
