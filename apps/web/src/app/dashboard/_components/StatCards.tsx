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
  const cards = [
    { label: "Active clients", value: stats.activeClients },
    { label: "At risk", value: stats.atRiskClients, accent: true },
    { label: "Nudges this month", value: stats.nudgesThisMonth },
    { label: "Rebookings recovered", value: stats.rebookingsRecovered },
    { label: "Est. $ recovered", value: stats.estDollarsRecovered, money: true },
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
    >
      {cards.map((c) => (
        <motion.div key={c.label} variants={fadeUp}>
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wide text-muted">{c.label}</p>
            <p
              className={`mt-2 font-display text-3xl ${
                c.accent ? "text-gold" : "text-offwhite"
              }`}
            >
              {c.money && "$"}
              <CountUp value={c.value} />
            </p>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}
