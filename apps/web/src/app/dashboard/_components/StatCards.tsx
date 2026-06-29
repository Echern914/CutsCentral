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
  winbackClientsRecovered: number;
  winbackDollarsRecovered: number;
}

export function StatCards({ stats }: { stats: Stats }) {
  const secondary = [
    { label: "Active clients", value: stats.activeClients },
    { label: "At risk", value: stats.atRiskClients, accent: true },
    { label: "Nudges this month", value: stats.nudgesThisMonth },
    { label: "Rebookings recovered", value: stats.rebookingsRecovered },
  ];

  // Only surface the win-back ("Growth Agent") result once it has actually
  // re-engaged someone this month - an empty card reads as a dead feature.
  const showWinback = stats.winbackClientsRecovered > 0;

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

      {/* Win-back ("Growth Agent") payoff - the clients it brought back this
          month + the real dollars recovered. Only shown once it's done something. */}
      {showWinback && (
        <motion.div variants={fadeUp} className="lg:col-span-3">
          <Card className="relative overflow-hidden p-6">
            <div
              className="absolute -left-10 -bottom-10 h-40 w-40 rounded-full bg-gold/15 blur-3xl"
              aria-hidden
            />
            <p className="text-xs uppercase tracking-wide text-muted">
              Win-back · brought back this month
            </p>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <p className="font-display text-4xl text-offwhite">
                <CountUp value={stats.winbackClientsRecovered} />
                <span className="ml-2 text-lg text-muted">
                  {stats.winbackClientsRecovered === 1 ? "client" : "clients"} re-engaged
                </span>
              </p>
              {stats.winbackDollarsRecovered > 0 && (
                <p className="font-display text-4xl text-gradient-gold">
                  $<CountUp value={stats.winbackDollarsRecovered} />
                  <span className="ml-2 text-lg text-muted">recovered</span>
                </p>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">
              Lapsed clients ChairBack automatically texted back to the chair.
            </p>
          </Card>
        </motion.div>
      )}
    </motion.div>
  );
}
