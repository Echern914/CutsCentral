"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { CountUp } from "@/components/motion/CountUp";
import { PunchGrid } from "@/components/rewards/PunchGrid";
import { RebookCountdown } from "@/components/rewards/RebookCountdown";
import { RewardCelebration } from "@/components/rewards/RewardCelebration";
import { RewardsClaimed } from "@/components/rewards/RewardsClaimed";
import { VisitHistory } from "@/components/rewards/VisitHistory";
import { ConsentCard } from "./ConsentCard";
import { resolveRewardsTheme, rewardsFontVars, surfaceStyle } from "./theme";
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
  const {
    shop,
    client,
    consent,
    punches,
    rewards,
    promotions,
    visits,
    redemptions,
    rebook,
  } = data;
  // Resolve the barber's full page identity. Every surface below reads from these
  // tokens (color, type, shape) so the client's rewards page matches the shop's
  // public mini-site instead of the generic dark app chrome.
  const t = resolveRewardsTheme(shop);
  const accent = t.accent;
  const fonts = rewardsFontVars(shop);
  // Which optional sections the barber chose to show. The balance + consent card
  // are always rendered (not gated). Empty list from the API can't happen (it
  // defaults to all), but treat empty as "show all" defensively.
  const visible = new Set(shop.rewardsSections);
  const show = (key: string) => visible.size === 0 || visible.has(key);
  const welcome = shop.rewardsWelcome?.trim();
  const ready = rewards.filter((r) => r.ready);
  const next = punches.nextTarget;
  // "ends in N days" depends on the clock - render it only after mount so the
  // SSR HTML can never disagree with the hydration pass.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const surface = surfaceStyle(t);

  // Root style: theme colors + the chosen font families exposed as locals the
  // page reads via `fontFamily: "var(--page-display)"` etc. (the --font-page-*
  // vars are declared by the route layout).
  const rootStyle: CSSProperties = {
    backgroundColor: t.bg,
    color: t.text,
    colorScheme: t.scheme,
    // @ts-expect-error - CSS custom properties are valid in style objects.
    "--page-display": fonts.display,
    "--page-body": fonts.body,
  };

  return (
    <div className="min-h-dvh" style={rootStyle}>
      <main
        className="relative mx-auto w-full max-w-md px-5 py-10"
        style={{ fontFamily: "var(--page-body)" }}
      >
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
                className="mx-auto mb-3 h-14 w-14 object-cover"
                style={{ border: `1px solid ${t.border}`, borderRadius: t.radius }}
              />
            ) : null}
            <p className="text-xs uppercase tracking-[0.2em]" style={{ color: t.muted }}>
              {shop.name}
            </p>
            <h1
              className="mt-2 text-3xl tracking-tight"
              style={{ fontFamily: "var(--page-display)" }}
            >
              {client.firstName ? `Hey ${client.firstName}` : "Your rewards"}
            </h1>
            {welcome && (
              <p className="mx-auto mt-2 max-w-xs text-sm" style={{ color: t.muted }}>
                {welcome}
              </p>
            )}
          </motion.header>

          {/* Punch balance */}
          <motion.div variants={fadeUp}>
            <div
              className={`p-6 text-center ${ready.length > 0 ? "ring-conic" : ""}`}
              style={surface}
            >
              <div
                className="text-6xl leading-none"
                style={{ color: accent, fontFamily: "var(--page-display)" }}
              >
                <CountUp value={punches.balance} />
                <span className="text-2xl" style={{ color: t.muted }}>
                  {" "}
                  {punches.balance === 1 ? "punch" : "punches"}
                </span>
              </div>
              <p className="mt-3 text-sm" style={{ color: t.muted }}>
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
            </div>
          </motion.div>

          {/* SMS consent - prominent when not yet opted in, quiet once handled */}
          <motion.div variants={fadeUp}>
            <ConsentCard
              magicToken={magicToken}
              shopName={shop.name}
              theme={t}
              initialState={consent.state}
              initialHasPhone={consent.hasPhone}
            />
          </motion.div>

          {/* Rebooking countdown - drives urgency to book the next visit */}
          {show("rebook") && (
            <motion.div variants={fadeUp}>
              <RebookCountdown rebook={rebook} bookingUrl={shop.bookingUrl} theme={t} />
            </motion.div>
          )}

          {/* Celebration when a reward is unlocked */}
          {ready.length > 0 && (
            <motion.div variants={fadeUp}>
              <RewardCelebration count={ready.length} label={ready[0]!.name} theme={t} />
            </motion.div>
          )}

          {/* This shop's live specials */}
          {show("promotions") && promotions.length > 0 && (
            <motion.section variants={fadeUp} className="flex flex-col gap-3">
              <h2 className="px-1 text-sm font-medium" style={{ color: t.muted }}>
                Right now
              </h2>
              <div className="flex flex-col gap-3">
                {promotions.map((promo) => {
                  const value = promoValue(promo);
                  const ends = mounted ? endsLabel(promo.endsAt) : null;
                  return (
                    <div
                      key={promo.id}
                      className="relative overflow-hidden p-5"
                      style={surface}
                    >
                      <div
                        className="absolute inset-y-0 left-0 w-1"
                        style={{ backgroundColor: accent }}
                        aria-hidden
                      />
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">
                            {promo.title}
                            {value && (
                              <span className="ml-2" style={{ color: accent }}>
                                {value}
                              </span>
                            )}
                          </p>
                          {promo.description && (
                            <p className="mt-1 text-xs" style={{ color: t.muted }}>
                              {promo.description}
                            </p>
                          )}
                          <p
                            className="mt-1.5 min-h-4 text-[11px] uppercase tracking-wide"
                            style={{ color: t.muted }}
                          >
                            {ends ?? ""}
                          </p>
                        </div>
                        {promo.code && (
                          <span
                            className="shrink-0 rounded-lg px-2.5 py-1.5 font-mono text-xs"
                            style={{ border: `1px dashed ${t.border}` }}
                          >
                            {promo.code}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.section>
          )}

          {/* Reward menu - this shop's own program */}
          {show("rewardMenu") && rewards.length > 0 && (
            <motion.section variants={fadeUp} className="flex flex-col gap-3">
              <h2 className="px-1 text-sm font-medium" style={{ color: t.muted }}>
                Reward menu
              </h2>
              <div className="overflow-hidden" style={surface}>
                <ul>
                  {rewards.map((reward, i) => {
                    const progress = Math.min(
                      100,
                      Math.round(
                        ((reward.punchCost - reward.remaining) / reward.punchCost) * 100,
                      ),
                    );
                    return (
                      <li
                        key={reward.id}
                        className="px-5 py-4"
                        style={i > 0 ? { borderTop: `1px solid ${t.border}` } : undefined}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {reward.emoji ? `${reward.emoji} ` : ""}
                              {reward.name}
                            </p>
                            {reward.description && (
                              <p className="mt-0.5 truncate text-xs" style={{ color: t.muted }}>
                                {reward.description}
                              </p>
                            )}
                          </div>
                          {reward.ready ? (
                            <span
                              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
                              style={{ backgroundColor: accent, color: t.onAccent }}
                            >
                              Ready!
                            </span>
                          ) : (
                            <span className="shrink-0 text-xs" style={{ color: t.muted }}>
                              {reward.punchCost - reward.remaining}/{reward.punchCost}
                            </span>
                          )}
                        </div>
                        <div
                          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full"
                          style={{ backgroundColor: t.border }}
                          role="progressbar"
                          aria-valuenow={progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="h-full rounded-full transition-all duration-200 ease-out"
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
              </div>
            </motion.section>
          )}

          {/* Punch grid toward the next reward (decorative for small targets) */}
          {show("punchGrid") && next && next.punchCost <= 20 && (
            <motion.div variants={fadeUp}>
              <div className="p-6" style={surface}>
                <PunchGrid
                  filled={next.punchCost - next.remaining}
                  threshold={next.punchCost}
                  theme={t}
                />
                <p className="mt-4 text-center text-xs" style={{ color: t.muted }}>
                  {next.punchCost - next.remaining}/{next.punchCost} toward your{" "}
                  {next.name}
                </p>
              </div>
            </motion.div>
          )}

          {/* CTA */}
          <motion.div variants={fadeUp} className="text-center">
            <a
              href={shop.bookingUrl}
              className="block w-full py-3.5 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01]"
              style={{
                backgroundColor: accent,
                color: t.onAccent,
                boxShadow: `0 8px 30px -10px ${accent}AA`,
                borderRadius: t.buttonRadius,
              }}
            >
              Book your next cut
            </a>
          </motion.div>

          {/* Rewards the client has claimed - their loyalty payoff, shown only
              once they've redeemed at least one. */}
          {show("claimed") && redemptions.length > 0 && (
            <motion.section variants={fadeUp} className="flex flex-col gap-3">
              <h2 className="px-1 text-sm font-medium" style={{ color: t.muted }}>
                Rewards claimed
              </h2>
              <RewardsClaimed redemptions={redemptions} theme={t} />
            </motion.section>
          )}

          {/* Visit history - each cut annotated with the punches it earned */}
          {show("visits") && (
            <motion.section variants={fadeUp} className="flex flex-col gap-3">
              <h2 className="px-1 text-sm font-medium" style={{ color: t.muted }}>
                Recent visits
              </h2>
              <VisitHistory visits={visits} theme={t} />
            </motion.section>
          )}

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
    </div>
  );
}
