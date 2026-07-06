"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp } from "@/components/motion/variants";
import { LineChart } from "@/components/charts/LineChart";
import { trendsAction } from "../actions";
import type { TrendPoint } from "./TrendsChart";

/**
 * Expandable trend charts, revealed from under the "Est. revenue recovered"
 * card. Click to open a panel with three single-series line charts over time —
 * new customers, successful payments, and rebookings recovered — with the same
 * 3/6/12-month range toggle as the Trends chart.
 *
 * Data plumbing mirrors TrendsChart: the default (6m) range renders the server
 * prop; other ranges re-fetch via trendsAction and never go stale. Charts only
 * fetch/animate once the panel is open.
 */
export function RevenueTrends({ series: initial }: { series: TrendPoint[] }) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState(6);
  const [override, setOverride] = useState<TrendPoint[] | null>(null);
  const [pending, setPending] = useState(false);
  const series = range === 6 ? initial : (override ?? initial);

  useEffect(() => {
    if (!open || range === 6) {
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
  }, [open, range, initial]);

  function pick(months: number) {
    if (months !== range) setRange(months);
  }

  const num = (v: number | undefined) => v ?? 0;
  const newCustomers = series.map((p) => ({ label: p.label, value: num(p.newClients) }));
  const payments = series.map((p) => ({ label: p.label, value: num(p.paymentsSucceeded) }));
  const rebookings = series.map((p) => ({ label: p.label, value: num(p.rebookingsRecovered) }));

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">Trends over time</h2>
            <p className="text-xs text-muted">
              New customers, payments, and rebookings recovered by month.
            </p>
          </div>
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="shrink-0 rounded-full border border-gold/50 px-5 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
          >
            {open ? "Hide trends ▴" : "View trends ▾"}
          </button>
        </div>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="panel"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
              className="overflow-hidden"
            >
              <div className="mt-4 border-t border-subtle pt-4">
                {/* Range toggle (matches the Trends chart control) */}
                <div className="mb-5 flex justify-end">
                  <div className="flex items-center gap-1 rounded-full border border-subtle p-0.5">
                    {[3, 6, 12].map((m) => (
                      <button
                        key={m}
                        onClick={() => pick(m)}
                        disabled={pending}
                        className={`rounded-full px-2.5 py-1 text-xs transition-colors duration-150 ease-out ${
                          range === m
                            ? "bg-gold text-charcoal"
                            : "text-muted hover:text-offwhite"
                        }`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-6 md:grid-cols-3">
                  <LineChart
                    title="New customers"
                    points={newCustomers}
                    stroke="#E6C964"
                    emptyLabel="No new customers in this range yet."
                  />
                  <LineChart
                    title="Payments"
                    points={payments}
                    stroke="#4ADE80"
                    emptyLabel="No card payments yet. Turn on ChairBack payments to track them."
                  />
                  <LineChart
                    title="Rebookings recovered"
                    points={rebookings}
                    stroke="#D4AF37"
                    emptyLabel="No recovered rebookings in this range yet."
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </motion.div>
  );
}
