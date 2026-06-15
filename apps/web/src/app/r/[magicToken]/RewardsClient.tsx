"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { CountUp } from "@/components/motion/CountUp";
import { PunchGrid } from "@/components/rewards/PunchGrid";
import { RebookCountdown } from "@/components/rewards/RebookCountdown";
import { RewardCelebration } from "@/components/rewards/RewardCelebration";
import { VisitHistory } from "@/components/rewards/VisitHistory";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConsentCard } from "./ConsentCard";
import type { RewardsData } from "./page";

function promoValue(p: RewardsData["promotions"][number]): string | null {
  switch (p.kind) {
    case "PERCENT_OFF":
      return p.percentOff ? `${p.percentOff}% off` : null;
    case "AMOUNT_OFF":
      return p.amountOff ? `$${p.amountOff} off` : null;
    case "FREE_ADDON":
      return null; // the title/description say it all
    case "EXTRA_PUNCHES":
      return p.extraPunches
        ? `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit`
        : null;
  }
}

function endsLabel(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return "last day";
  if (days <= 14) return `ends in ${days} days`;
  return `ends ${new Date(endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function RewardsClient({
  data,
  magicToken,
}: {
  data: RewardsData;
  magicToken: string;
}) {
  const { shop, client, consent, punches, rewards, promotions, visits, rebook } =
    data;
  const accent = shop.accentColor || "#D4AF37"; // shop brand color or default gold
  const ready = rewards.filter((r) => r.ready);
  const next = punches.nextTarget;
  // "ends in N days" depends on the clock - render it only after mount so the
  // SSR HTML can never disagree with the hydration pass.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <main className="relative mx-auto min-h-dvh w-full max-w-md px-5 py-10">
      <div
        className="absolute left-1/2 top-24 -z-10 h-80 w-80 -translate-x-1/2 rounded-full opacity-15 blur-3xl"
        style={{ backgroundColor: accent }}
        aria-hidden
      />
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-6"
      >
        {/* Header */}
        <motion.header variants={fadeUp} className="text-center">
          {shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shop.logoUrl}
              alt={shop.name}
              className="mx-auto mb-3 h-14 w-14 rounded-2xl border border-subtle object-cover"
            />
          ) : null}
          <p className="text-xs uppercase tracking-[0.2em] text-muted">
            {shop.name}
          </p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">
            {client.firstName ? `Hey ${client.firstName}` : "Your rewards"}
          </h1>
        </motion.header>

        {/* Punch balance */}
        <motion.div variants={fadeUp}>
          <Card className={`p-6 text-center ${ready.length > 0 ? "ring-conic" : ""}`}>
            <div
              className="font-display text-6xl leading-none"
              style={{ color: accent }}
            >
              <CountUp value={punches.balance} />
              <span className="text-2xl text-muted">
                {" "}
                {punches.balance === 1 ? "punch" : "punches"}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted">
              {ready.length > 0
                ? ready.length === 1
                  ? `Your ${ready[0]!.name} is ready!`
                  : `${ready.length} rewards ready to claim!`
                : next
                  ? `${next.remaining} more to your ${next.name}`
                  : rewards.length > 0
                    ? "Keep visiting to stack up punches"
                    : "Every visit earns punches"}
            </p>
          </Card>
        </motion.div>

        {/* SMS consent - prominent when not yet opted in, quiet once handled */}
        <motion.div variants={fadeUp}>
          <ConsentCard
            magicToken={magicToken}
            shopName={shop.name}
            accent={accent}
            initialState={consent.state}
            initialHasPhone={consent.hasPhone}
          />
        </motion.div>

        {/* Rebooking countdown - drives urgency to book the next visit */}
        <motion.div variants={fadeUp}>
          <RebookCountdown rebook={rebook} bookingUrl={shop.bookingUrl} />
        </motion.div>

        {/* Celebration when a reward is unlocked */}
        {ready.length > 0 && (
          <motion.div variants={fadeUp}>
            <RewardCelebration count={ready.length} label={ready[0]!.name} />
          </motion.div>
        )}

        {/* This shop's live specials */}
        {promotions.length > 0 && (
          <motion.section variants={fadeUp} className="flex flex-col gap-3">
            <h2 className="px-1 text-sm font-medium text-muted">Right now</h2>
            <div className="flex flex-col gap-3">
              {promotions.map((promo) => {
                const value = promoValue(promo);
                const ends = mounted ? endsLabel(promo.endsAt) : null;
                return (
                  <Card
                    key={promo.id}
                    className="relative overflow-hidden p-5"
                  >
                    <div
                      className="absolute inset-y-0 left-0 w-1"
                      style={{ backgroundColor: accent }}
                      aria-hidden
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-offwhite">
                          {promo.title}
                          {value && (
                            <span className="ml-2" style={{ color: accent }}>
                              {value}
                            </span>
                          )}
                        </p>
                        {promo.description && (
                          <p className="mt-1 text-xs text-muted">{promo.description}</p>
                        )}
                        <p className="mt-1.5 min-h-4 text-[11px] uppercase tracking-wide text-muted/80">
                          {ends ?? ""}
                        </p>
                      </div>
                      {promo.code && (
                        <span className="shrink-0 rounded-lg border border-dashed border-subtle px-2.5 py-1.5 font-mono text-xs text-offwhite">
                          {promo.code}
                        </span>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* Reward menu - this shop's own program */}
        {rewards.length > 0 && (
          <motion.section variants={fadeUp} className="flex flex-col gap-3">
            <h2 className="px-1 text-sm font-medium text-muted">Reward menu</h2>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-subtle">
                {rewards.map((reward) => {
                  const progress = Math.min(
                    100,
                    Math.round(
                      ((reward.punchCost - reward.remaining) / reward.punchCost) * 100,
                    ),
                  );
                  return (
                    <li key={reward.id} className="px-5 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-offwhite">
                            {reward.emoji ? `${reward.emoji} ` : ""}
                            {reward.name}
                          </p>
                          {reward.description && (
                            <p className="mt-0.5 truncate text-xs text-muted">
                              {reward.description}
                            </p>
                          )}
                        </div>
                        {reward.ready ? (
                          <span
                            className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-charcoal"
                            style={{ backgroundColor: accent }}
                          >
                            Ready!
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs text-muted">
                            {reward.punchCost - reward.remaining}/{reward.punchCost}
                          </span>
                        )}
                      </div>
                      <div
                        className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-charcoal-700"
                        role="progressbar"
                        aria-valuenow={progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${progress}%`,
                            backgroundColor: accent,
                            opacity: reward.ready ? 1 : 0.65,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </motion.section>
        )}

        {/* Punch grid toward the next reward (decorative for small targets) */}
        {next && next.punchCost <= 20 && (
          <motion.div variants={fadeUp}>
            <Card className="p-6">
              <PunchGrid
                filled={next.punchCost - next.remaining}
                threshold={next.punchCost}
              />
              <p className="mt-4 text-center text-xs text-muted">
                {next.punchCost - next.remaining}/{next.punchCost} toward your{" "}
                {next.name}
              </p>
            </Card>
          </motion.div>
        )}

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

        {/* The shop's own mini-site */}
        {shop.pageSlug && (
          <motion.footer variants={fadeUp} className="pt-2 text-center">
            <a
              href={`/s/${shop.pageSlug}`}
              className="text-xs hover:underline"
              style={{ color: accent }}
            >
              More from {shop.name} →
            </a>
          </motion.footer>
        )}
      </motion.div>
    </main>
  );
}
