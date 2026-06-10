"use client";

import { motion } from "framer-motion";
import { CountUp } from "@/components/motion/CountUp";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";

export interface Stats {
  activeClients: number;
  atRiskClients: number;
  nudgesThisMonth: number;
  rebookingsRecovered: number;
  estDollarsRecovered: number;
  avgTicket: number;
}

export function StatCards({ stats }: { stats: Stats }) {
  const secondary = [
    { label: "Active clients", value: stats.activeClients },
    { label: "At risk", value: stats.atRiskClients, accent: true },
    { label: "Nudges this month", value: stats.nudgesThisMonth },
    { label: "Rebookings recovered", value: stats.rebookingsRecovered },
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid gap-4 lg:grid-cols-3"
    >
      {/* Hero: estimated revenue recovered */}
      <motion.div variants={fadeUp} className="lg:col-span-1">
        <Card className="relative h-full overflow-hidden p-6">
          <div
            className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gold/15 blur-3xl"
            aria-hidden
          />
          <p className="text-xs uppercase tracking-wide text-muted">
            Est. revenue recovered
          </p>
          <p className="mt-2 font-display text-6xl text-gradient-gold">
            $<CountUp value={stats.estDollarsRecovered} />
          </p>
          <p className="mt-3 text-xs text-muted">
            {stats.rebookingsRecovered} rebookings × ${Math.round(stats.avgTicket)} avg
            ticket
          </p>
        </Card>
      </motion.div>

      {/* Supporting metrics */}
      <motion.div variants={fadeUp} className="lg:col-span-2">
        <div className="grid h-full grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {secondary.map((c) => (
            <Card
              key={c.label}
              hover
              className="flex flex-col justify-center p-5"
            >
              <p className="text-xs uppercase tracking-wide text-muted">{c.label}</p>
              <p
                className={`mt-2 font-display text-3xl ${
                  c.accent ? "text-gold" : "text-offwhite"
                }`}
              >
                <CountUp value={c.value} />
              </p>
            </Card>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
