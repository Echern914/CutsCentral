"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { DEMO } from "@chairback/config/demo";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { DemoTour } from "@/components/tour/DemoTour";
import { CountUp } from "@/components/motion/CountUp";
import { PunchGrid } from "@/components/rewards/PunchGrid";
import { RebookCountdown } from "@/components/rewards/RebookCountdown";
import { RewardCelebration } from "@/components/rewards/RewardCelebration";
import { RewardsClaimed } from "@/components/rewards/RewardsClaimed";
import { VisitHistory } from "@/components/rewards/VisitHistory";
import { ConsentCard } from "./ConsentCard";
import { CadenceCard } from "./CadenceCard";
import { PushOptIn } from "./PushOptIn";
import { GetTheApp } from "./GetTheApp";
import { AddToWallet } from "./AddToWallet";
import { DeleteMyData } from "./DeleteMyData";
import { resolveRewardsTheme, rewardsFontVars, surfaceStyle, type RewardsTheme } from "./theme";
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
  vapidPublicKey,
  appStoreUrl,
  playStoreUrl,
}: {
  data: RewardsData;
  magicToken: string;
  /** VAPID public key (null when push isn't configured -> opt-in UI hidden). */
  vapidPublicKey: string | null;
  /** iOS App Store link for the "Get the app" banner (null => banner hidden). */
  appStoreUrl: string | null;
  /** Android Play Store link (optional). */
  playStoreUrl: string | null;
}) {
  const {
    shop,
    client,
    cadence,
    loyalty,
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
  // Master rewards switch: off = this page is a booking/visit hub with zero
  // punch/reward surfaces (the API already empties rewards/cards/redemptions;
  // this flag removes the always-shown balance card + loyalty tier too).
  const rewardsOn = shop.rewardsEnabled ?? true;
  const welcome = shop.rewardsWelcome?.trim();
  const ready = rewards.filter((r) => r.ready);
  const next = punches.nextTarget;
  // "ends in N days" depends on the clock - render it only after mount so the
  // SSR HTML can never disagree with the hydration pass.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Tell the native iOS shell the REAL rewards UI has mounted - NOT the streamed
  // loading.tsx shell (see the hook for why every public page must send this).
  useSignalNativeReady();

  const surface = surfaceStyle(t);

  // Multi-card mode: more than one visible punch card (default + customs).
  // With one (or a payload from an older API without `cards`), the page renders
  // the classic single-card tree UNTOUCHED - the zero-regression gate.
  const cards = data.cards ?? [];
  const multiCard = cards.length > 1;
  // "Ready" celebration spans every card the client can see.
  const readyAll = multiCard ? cards.flatMap((c) => c.rewards.filter((r) => r.ready)) : ready;

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
      {/* Guided client-experience tour — demo tenant only. Step anchors are the
          data-tour attributes below (keep in sync with
          packages/config/src/demoTour.ts). */}
      {magicToken === DEMO.MAGIC_TOKEN && <DemoTour route="rewards" />}
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
              {client.firstName
                ? `Hey ${client.firstName}`
                : rewardsOn
                  ? "Your rewards"
                  : "Welcome"}
            </h1>
            {welcome && (
              <p className="mx-auto mt-2 max-w-xs text-sm" style={{ color: t.muted }}>
                {welcome}
              </p>
            )}
            {/* Loyalty status: a colored "member" pill once they've reached a
                tier, plus a gentle nudge toward the next one (which doubles as a
                "1 visit to Bronze" prompt for a brand-new client). */}
            {rewardsOn && loyalty.tier && loyalty.color && (
              <span
                className="mt-3 inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide"
                style={{
                  color: loyalty.color,
                  backgroundColor: `${loyalty.color}1A`,
                  border: `1px solid ${loyalty.color}55`,
                }}
              >
                {loyalty.label} member
              </span>
            )}
            {rewardsOn && loyalty.nextTier && (
              <p className="mt-2 text-xs" style={{ color: t.muted }}>
                {loyalty.nextTier.visitsAway}{" "}
                {loyalty.nextTier.visitsAway === 1 ? "visit" : "visits"} to{" "}
                {loyalty.nextTier.label}
              </p>
            )}
          </motion.header>

          {/* Punch balance. Multi-card shops get one stacked surface per card
              (each with its own balance, accent, rewards, and grid); everyone
              else gets the classic single-balance card, byte-for-byte. A
              rewards-off shop renders NO balance card at all. */}
          {!rewardsOn ? null : multiCard ? (
            <motion.div variants={fadeUp} className="flex flex-col gap-4" data-tour="punch-card">
              {cards.map((card) => (
                <PunchCardSurface
                  key={card.id ?? "default"}
                  card={card}
                  theme={t}
                  surface={surface}
                  showRewards={show("rewardMenu")}
                  showGrid={show("punchGrid")}
                />
              ))}
            </motion.div>
          ) : (
            <motion.div variants={fadeUp} data-tour="punch-card">
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
          )}

          {/* One-tap cadence capture (cold start): only for a client with no
              stated cadence and not enough visit history to have computed one.
              The card self-suppresses after a skip (localStorage), so this
              server-side gate just keeps it out of the tree once it's moot. */}
          {cadence.preference === null && !cadence.computed && (
            <CadenceCard magicToken={magicToken} theme={t} />
          )}

          {/* Get-the-app nudge - only on a mobile browser without the app, and
              only once an App Store link is configured. Renders nothing inside
              the native app or on desktop. */}
          <GetTheApp
            shopName={shop.name}
            theme={t}
            appStoreUrl={appStoreUrl}
            playStoreUrl={playStoreUrl}
          />

          {/* Apple Wallet punch card - iOS Safari only, and only once the API
              can mint passes (wallet.available). Renders nothing elsewhere. */}
          <AddToWallet
            magicToken={magicToken}
            available={data.wallet?.available ?? false}
          />

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

          {/* Push opt-in - the free, no-SMS alternative. Only when push is
              configured; the component itself further hides on unsupported
              browsers, so most of the time it renders nothing. */}
          {vapidPublicKey && (
            <motion.div variants={fadeUp}>
              <PushOptIn
                magicToken={magicToken}
                shopName={shop.name}
                theme={t}
                vapidPublicKey={vapidPublicKey}
              />
            </motion.div>
          )}

          {/* Rebooking countdown - drives urgency to book the next visit */}
          {show("rebook") && (
            <motion.div variants={fadeUp} data-tour="loyalty-extras">
              <RebookCountdown rebook={rebook} bookingUrl={shop.bookingUrl} theme={t} />
            </motion.div>
          )}

          {/* Celebration when a reward is unlocked (any card) */}
          {readyAll.length > 0 && (
            <motion.div variants={fadeUp}>
              <RewardCelebration count={readyAll.length} label={readyAll[0]!.name} theme={t} />
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

          {/* Reward menu - this shop's own program. In multi-card mode each
              card surface above already lists its own rewards. */}
          {!multiCard && show("rewardMenu") && rewards.length > 0 && (
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
                          aria-label={`Progress toward ${reward.name}`}
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

          {/* Punch grid toward the next reward (decorative for small targets).
              Multi-card mode draws a grid inside each card surface instead. */}
          {!multiCard && show("punchGrid") && next && next.punchCost <= 20 && (
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

          {/* CTA - only when the shop has an external booking link. Without one
              there's nowhere to send them, so we hide the button rather than
              render a dead link (they're already on their rewards page). */}
          {shop.bookingUrl && (
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
          )}

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

          {/* Support (App Store 1.5): the customer side must offer help too.
              mailto opens the Mail app inside the iOS shell (AppWebView hands
              external schemes to iOS); /support renders in place. */}
          <motion.footer variants={fadeUp} className="pt-2 text-center">
            <p className="text-xs" style={{ color: t.muted }}>
              Questions or trouble with your rewards?{" "}
              <a
                href="mailto:support@getchairback.com"
                className="hover:underline"
                style={{ color: accent }}
              >
                support@getchairback.com
              </a>{" "}
              ·{" "}
              <a href="/support" className="hover:underline" style={{ color: accent }}>
                Help
              </a>
            </p>
          </motion.footer>

          {/* Self-serve data deletion (App Store 5.1.1(v)) - a quiet control,
              always available, at the very bottom of the page. */}
          <motion.div variants={fadeUp} className="pt-2">
            <DeleteMyData magicToken={magicToken} shopName={shop.name} theme={t} />
          </motion.div>
        </motion.div>
      </main>
    </div>
  );
}

/**
 * One punch card in the multi-card stack: its own balance, accent, reward
 * rows, and (for small targets) a dot grid. The card's accentColor overrides
 * the shop accent so a "VIP" card can look like ITS card, not the default.
 */
function PunchCardSurface({
  card,
  theme,
  surface,
  showRewards,
  showGrid,
}: {
  card: NonNullable<RewardsData["cards"]>[number];
  theme: RewardsTheme;
  surface: CSSProperties;
  showRewards: boolean;
  showGrid: boolean;
}) {
  const t = theme;
  const accent = card.accentColor ?? t.accent;
  const cardTheme: RewardsTheme = { ...t, accent };
  const readyCount = card.rewards.filter((r) => r.ready).length;
  const target = card.nextTarget;

  return (
    <div
      className={`overflow-hidden ${readyCount > 0 ? "ring-conic" : ""}`}
      style={surface}
    >
      <div className="p-6 text-center">
        <p
          className="text-xs font-semibold uppercase tracking-[0.2em]"
          style={{ color: accent }}
        >
          {card.emoji ? `${card.emoji} ` : ""}
          {card.name}
          {card.exclusive && (
            <span
              className="ml-2 rounded-full px-2 py-0.5 text-[9px] tracking-wide"
              style={{ border: `1px solid ${accent}66`, color: accent }}
            >
              VIP
            </span>
          )}
        </p>
        <div
          className="mt-3 text-5xl leading-none"
          style={{ color: accent, fontFamily: "var(--page-display)" }}
        >
          <CountUp value={card.balance} />
          <span className="text-xl" style={{ color: t.muted }}>
            {" "}
            {card.balance === 1 ? "punch" : "punches"}
          </span>
        </div>
        <p className="mt-3 text-sm" style={{ color: t.muted }}>
          {readyCount > 0
            ? readyCount === 1
              ? `Your ${card.rewards.find((r) => r.ready)!.name} is ready!`
              : `${readyCount} rewards ready to claim!`
            : target
              ? `${target.remaining} more to your ${target.name}`
              : card.rewards.length > 0
                ? "Keep visiting to stack up punches"
                : "Every visit earns punches"}
        </p>
        {showGrid && target && target.punchCost <= 20 && (
          <div className="mt-5">
            <PunchGrid
              filled={target.punchCost - target.remaining}
              threshold={target.punchCost}
              theme={cardTheme}
            />
          </div>
        )}
      </div>

      {showRewards && card.rewards.length > 0 && (
        <ul>
          {card.rewards.map((reward) => {
            const progress = Math.min(
              100,
              Math.round(((reward.punchCost - reward.remaining) / reward.punchCost) * 100),
            );
            return (
              <li
                key={reward.id}
                className="px-5 py-4"
                style={{ borderTop: `1px solid ${t.border}` }}
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
                  aria-label={`Progress toward ${reward.name}`}
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
      )}
    </div>
  );
}
