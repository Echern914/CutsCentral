"use client";

import { motion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { CountUp } from "@/components/motion/CountUp";
import { PunchGrid } from "@/components/rewards/PunchGrid";
import { RebookCountdown } from "@/components/rewards/RebookCountdown";
import { RewardCelebration } from "@/components/rewards/RewardCelebration";
import { VisitHistory } from "@/components/rewards/VisitHistory";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { RewardsData } from "./page";

export function RewardsClient({ data }: { data: RewardsData }) {
  const { shop, client, punches, visits, rebook } = data;
  const remaining = punches.threshold - punches.towardNext;
  const rewardReady = punches.towardNext === 0 && punches.balance > 0;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10">
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-6"
      >
        {/* Header */}
        <motion.header variants={fadeUp} className="text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">
            {shop.name}
          </p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">
            {client.firstName ? `Hey ${client.firstName}` : "Your rewards"}
          </h1>
        </motion.header>

        {/* Punch counter */}
        <motion.div variants={fadeUp}>
          <Card className="p-6 text-center">
            <div className="font-display text-6xl text-gold leading-none">
              <CountUp value={punches.towardNext} />
              <span className="text-muted text-2xl">/{punches.threshold}</span>
            </div>
            <p className="mt-3 text-sm text-muted">
              {rewardReady
                ? `Your ${shop.rewardLabel} is ready!`
                : `${remaining} more ${remaining === 1 ? "cut" : "cuts"} to your ${shop.rewardLabel}`}
            </p>
          </Card>
        </motion.div>

        {/* Rebooking countdown — drives urgency to book the next visit */}
        <motion.div variants={fadeUp}>
          <RebookCountdown rebook={rebook} bookingUrl={shop.bookingUrl} />
        </motion.div>

        {/* Celebration when a reward is unlocked */}
        {rewardReady && (
          <motion.div variants={fadeUp}>
            <RewardCelebration rewardLabel={shop.rewardLabel} />
          </motion.div>
        )}

        {/* Punch grid */}
        <motion.div variants={fadeUp}>
          <Card className="p-6">
            <PunchGrid filled={punches.towardNext} threshold={punches.threshold} />
          </Card>
        </motion.div>

        {/* CTA */}
        <motion.div variants={fadeUp} className="text-center">
          <LinkButton href={shop.bookingUrl} className="w-full">
            Book your next cut
          </LinkButton>
        </motion.div>

        {/* Visit history */}
        <motion.section variants={fadeUp} className="flex flex-col gap-3">
          <h2 className="px-1 text-sm font-medium text-muted">Recent visits</h2>
          <VisitHistory visits={visits} />
        </motion.section>

        <motion.footer
          variants={fadeUp}
          className="pt-2 text-center text-xs text-muted"
        >
          Total punches earned:{" "}
          <span className="text-offwhite">{punches.balance}</span>
        </motion.footer>
      </motion.div>
    </main>
  );
}
