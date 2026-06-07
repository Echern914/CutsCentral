"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp } from "@/components/motion/variants";

export interface TrendPoint {
  label: string;
  visits: number;
  nudges: number;
}

/**
 * Lightweight dependency-free bar chart: completed visits vs nudges sent over the
 * last 6 months. Grouped bars per month, scaled to the max value.
 */
export function TrendsChart({ series }: { series: TrendPoint[] }) {
  const max = Math.max(1, ...series.flatMap((p) => [p.visits, p.nudges]));
  const hasData = series.some((p) => p.visits > 0 || p.nudges > 0);

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg">Last 6 months</h2>
          <div className="flex items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gold" /> Visits
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted" /> Nudges
            </span>
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
