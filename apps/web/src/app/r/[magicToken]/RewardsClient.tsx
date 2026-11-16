"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { DEMO } from "@chairback/config/demo";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { DemoTour } from "@/components/tour/DemoTour";
import { RebookCountdown } from "@/components/rewards/RebookCountdown";
import { RewardCelebration } from "@/components/rewards/RewardCelebration";
import { RewardsClaimed } from "@/components/rewards/RewardsClaimed";
import { VisitHistory } from "@/components/rewards/VisitHistory";
import { ConsentCard } from "./ConsentCard";
import { EmailChoice } from "./EmailChoice";
import { CadenceCard } from "./CadenceCard";
import { NextVisitCard } from "./NextVisitCard";
import { PushOptIn } from "./PushOptIn";
import { GetTheApp } from "./GetTheApp";
import { AddToWallet } from "@/components/AddToWallet";
import { TextToBook } from "@/components/TextToBook";
import { DeleteMyData } from "./DeleteMyData";
import { YourStatus } from "./YourStatus";
import { PunchPass, type PunchPassProps } from "./PunchPass";
import { readableOn } from "@/lib/contrast";
import { resolveRewardsTheme, rewardsFontVars, surfaceStyle, type RewardsTheme } from "./theme";
import { AppFrameScheme } from "@/components/PageScheme";
// The interface lives with the rewards sub-route (its page owns the API call);
// this component just renders whichever page mounts it.
import type { RewardsData } from "./rewards/page";
import { formatPrice } from "@/lib/serviceFields";

function promoValue(p: RewardsData["promotions"][number]): string | null {
  switch (p.kind) {
    case "PERCENT_OFF":
      return p.percentOff ? `${p.percentOff}% off` : null;
    case "AMOUNT_OFF":
      return p.amountOff ? `${formatPrice(Number(p.amountOff))} off` : null;
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
  shopHref = null,
  serviceNoun = "visit",
}: {
  data: RewardsData;
  magicToken: string;
  /**
   * The shop's word for a visit, resolved server-side. NEUTRAL default: this is
   * a public page and a wrong guess reaches the customer, not the owner.
   */
  serviceNoun?: string;
  /** VAPID public key (null when push isn't configured -> opt-in UI hidden). */
  vapidPublicKey: string | null;
  /** iOS App Store link for the "Get the app" banner (null => banner hidden). */
  appStoreUrl: string | null;
  /** Android Play Store link (optional). */
  playStoreUrl: string | null;
  /**
   * The client's landing page (/r/<token>), set when the shop HAS a public
   * page and this renders as its rewards sub-view: shows a back link and hides
   * the booking CTA (the shop page owns Book). Null = STANDALONE - the shop has
   * no public page, this IS the landing, and it keeps its own booking CTA so a
   * bookingUrl-only shop's clients don't lose their only way to book.
   */
  shopHref?: string | null;
}) {
  const {
    shop,
    client,
    cadence,
    loyalty,
    usual,
    consent,
    punches,
    rewards,
    promotions,
    visits,
    redemptions,
    rebook,
    nextVisit,
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
  // Who the pass belongs to, printed on every card they hold.
  const holder = { shopName: shop.name, logoUrl: shop.logoUrl, firstName: client.firstName, visits: loyalty.visits };
  const tierBadge = loyalty.tier && loyalty.label ? { label: loyalty.label, color: loyalty.color } : null;

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
      {/* The iPhone app's bar above this page wears the same scheme. */}
      <AppFrameScheme scheme={t.scheme} />
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
            {/* Back to the shop's page - the client's way out of this sub-view.
                The ONLY navigation on this page by design: everything else
                (booking included) lives on the shop page it returns to. */}
            {shopHref && (
              <a
                href={shopHref}
                className="mb-4 inline-flex items-center gap-1.5 text-sm hover:underline"
                style={{ color: t.muted }}
              >
                ← {shop.name}
              </a>
            )}
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
            {/* Loyalty status: the tier they hold is printed on their pass
                (PunchPass), and the header keeps what it is worth and the
                nudge toward the next one (which doubles as a "1 visit to
                Bronze" prompt for a brand-new client). */}
            {/* What the tier is actually WORTH here. A rank with nothing
                attached is a badge; a rank with a promise under it is a reason
                to come back. Rendered only when the shop has written one. */}
            {rewardsOn && loyalty.perk && (
              <p className="mt-3 text-xs font-medium" style={{ color: t.text }}>
                {loyalty.label ? `${loyalty.label} · ` : ""}
                {loyalty.perk}
              </p>
            )}

            {/* 🔴 THE BAR. The count alone ("2 visits to Gold") is a fact; the
                bar is the thing that reads as nearly-there at a glance, which
                is the whole reason to show a client their tier at all. It fills
                across the CURRENT band, so the last visit before a tier looks
                different from the first. */}
            {rewardsOn && loyalty.nextTier && (
              <div className="mx-auto mt-3 w-full max-w-[15rem]">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full"
                  style={{ backgroundColor: `${loyalty.color ?? accent}26` }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(loyalty.fraction * 100)}
                  aria-label={`Progress to ${loyalty.nextTier.label}`}
                >
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: loyalty.color ?? accent }}
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(loyalty.fraction * 100)}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>
                <p className="mt-1.5 text-xs" style={{ color: t.muted }}>
                  {/* The shop's rules can ask for money or a recent stretch of
                      visits, so the API says what is left in words; the visit
                      count is only for an API that predates rules. */}
                  {loyalty.nextTier.summary ??
                    `${loyalty.nextTier.visitsAway} ${loyalty.nextTier.visitsAway === 1 ? "visit" : "visits"} to ${loyalty.nextTier.label}`}
                  {loyalty.nextTier.perk ? ` — ${loyalty.nextTier.perk}` : ""}
                </p>
              </div>
            )}
          </motion.header>

          {/* The customer's next appointment - first, because it is the one thing
              someone opens the app for on the day. Not gated by the barber's
              rewards-section toggles or the rewards master switch: it is not a
              reward, it is their booking. */}
          {nextVisit && (
            <motion.div variants={fadeUp} className="flex flex-col gap-3">
              <NextVisitCard visit={nextVisit} theme={t} />
              {/* The BOOKING in Wallet, not the punch card — and only for a
                  ChairBack booking, because an Acuity-synced visit has no
                  manageToken and therefore nothing we can mint a pass from. */}
              {nextVisit.manageToken && (
                <AddToWallet
                  href={`/book/manage/${nextVisit.manageToken}/wallet-pass`}
                  available={data.wallet?.appointment ?? false}
                  // The pass is for one seat, so a party's card says which.
                  label={nextVisit.party ? "Add the first appointment to Apple Wallet" : "Add this appointment to Apple Wallet"}
                  // Enables the in-app native path; ignored in Safari.
                  manageToken={nextVisit.manageToken}
                />
              )}
            </motion.div>
          )}

          {/* The shop's AI text line. High on the page on purpose: this is a
              returning client, and "text to see what's open" is the fastest
              path back into the chair — faster than any booking link. Renders
              only when the receptionist would actually answer. */}
          {shop.receptionistNumber && (
            <motion.div variants={fadeUp}>
              <TextToBook
                number={shop.receptionistNumber}
                shopName={shop.name}
                accent={accent}
                muted={t.muted}
                text={t.text}
              />
            </motion.div>
          )}

          {/* Punch balance, printed as a pass (PunchPass): the count toward
              the next reward, a punch drawn for each (the "Punch grid" section
              toggle hides them), the tier, the client's name and visits.
              Multi-card shops get one pass per card - its own name, accent and
              balance - with that card's rewards listed under it. A rewards-off
              shop renders NO balance card at all. */}
          {!rewardsOn ? null : multiCard ? (
            <motion.div variants={fadeUp} className="flex flex-col gap-5" data-tour="punch-card">
              {cards.map((card) => (
                <PunchCardSurface
                  key={card.id ?? "default"}
                  card={card}
                  theme={t}
                  surface={surface}
                  showRewards={show("rewardMenu")}
                  showGrid={show("punchGrid")}
                  holder={holder}
                  // The tier belongs to the client, so it is printed once: on
                  // the shop's own card, the one every visit punches.
                  tier={card.id == null ? tierBadge : null}
                />
              ))}
            </motion.div>
          ) : (
            <motion.div variants={fadeUp} data-tour="punch-card">
              <PunchPass
                theme={t}
                {...holder}
                balance={punches.balance}
                next={next}
                ready={ready}
                hasRewards={rewards.length > 0}
                badge={tierBadge}
                showDots={show("punchGrid")}
              />
            </motion.div>
          )}

          {/* Apple Wallet punch card, right under the card it puts in Wallet -
              iOS Safari only, and only once the API can mint passes
              (wallet.available). Renders nothing elsewhere. */}
          <AddToWallet
            href={`/r/${magicToken}/wallet-pass`}
            available={data.wallet?.available ?? false}
            label="Add your punch card to Apple Wallet"
          />

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

          {/* Marketing email on/off - only with an address to send to. */}
          {data.emailMarketing?.hasEmail && (
            <motion.div variants={fadeUp}>
              <EmailChoice
                magicToken={magicToken}
                shopName={shop.name}
                theme={t}
                initialState={data.emailMarketing.state}
              />
            </motion.div>
          )}

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
          {!nextVisit && show("rebook") && (
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
                              className="shrink-0 rounded-md px-3 py-1 text-xs font-semibold"
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

          {/* Booking CTA only in STANDALONE mode (shop has no public page, so
              this page is the landing and their only way to book). When this is
              the shop page's rewards sub-view, the shop page owns Book - two
              competing "book" entry points made the card feel like an ad rather
              than the client's own record; back-to-shop lives in the header. */}
          {!shopHref && (usual || shop.bookingUrl) && (
            <motion.div variants={fadeUp} className="text-center">
              {/* 🔴 "The usual" first, when we know it. The generic link drops
                  the client at a menu they have already worked through however
                  many times they have been here - service, then provider, then
                  a day, then a time. This one lands them on the calendar for
                  the exact thing they had last time, so the only decision left
                  is when. Falls back to the plain link the moment anything is
                  unknown, retired, or belongs to another booking system. */}
              {usual ? (
                <>
                  <a
                    href={usual.url}
                    className="block w-full py-3.5 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01]"
                    style={{
                      backgroundColor: accent,
                      color: t.onAccent,
                      boxShadow: `0 8px 30px -10px ${accent}AA`,
                      borderRadius: t.buttonRadius,
                    }}
                  >
                    Book the usual — {usual.serviceName} with {usual.staffName}
                  </a>
                  {shop.bookingUrl && (
                    <a
                      href={shop.bookingUrl}
                      className="mt-2 inline-block text-xs underline underline-offset-2"
                      style={{ color: t.muted }}
                    >
                      Book something else
                    </a>
                  )}
                </>
              ) : shop.bookingUrl ? (
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
                  Book your next {serviceNoun}
                </a>
              ) : null}
            </motion.div>
          )}

          {/* Your status: every tier here - what it takes, what it gets, which
              one they hold and which is next. Rewards on only (the API also
              sends an empty ladder when off). Not one of the shop's section
              toggles: the badge above never was either. */}
          {rewardsOn && (loyalty.ladder?.length ?? 0) > 0 && (
            <motion.section variants={fadeUp} className="flex flex-col gap-3" data-qa="your-status-section">
              <h2 className="px-1 text-sm font-medium" style={{ color: t.muted }}>
                Your status
              </h2>
              <YourStatus loyalty={loyalty} theme={t} />
            </motion.section>
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
 * One punch card in the multi-card stack: its own pass - name, accent,
 * balance and punches - with that card's rewards listed under it. The card's
 * accentColor overrides the shop accent so a "VIP" card looks like ITS card,
 * not the default, and an exclusive card says VIP where a tier would go.
 */
function PunchCardSurface({
  card,
  theme,
  surface,
  showRewards,
  showGrid,
  holder,
  tier,
}: {
  card: NonNullable<RewardsData["cards"]>[number];
  theme: RewardsTheme;
  surface: CSSProperties;
  showRewards: boolean;
  showGrid: boolean;
  holder: Pick<PunchPassProps, "shopName" | "logoUrl" | "firstName" | "visits">;
  tier: PunchPassProps["badge"];
}) {
  const t = theme;
  const accent = card.accentColor ?? t.accent;
  const cardTheme: RewardsTheme = { ...t, accent, onAccent: readableOn(accent) };

  return (
    <div className="flex flex-col gap-2">
      <PunchPass
        theme={cardTheme}
        {...holder}
        title={`${card.emoji ? `${card.emoji} ` : ""}${card.name}`}
        badge={card.exclusive ? { label: "VIP", color: accent } : tier}
        balance={card.balance}
        next={card.nextTarget}
        ready={card.rewards.filter((r) => r.ready)}
        hasRewards={card.rewards.length > 0}
        showDots={showGrid}
      />

      {showRewards && card.rewards.length > 0 && (
        <ul className="overflow-hidden" style={surface}>
          {card.rewards.map((reward, i) => {
            const progress = Math.min(
              100,
              Math.round(((reward.punchCost - reward.remaining) / reward.punchCost) * 100),
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
                      className="shrink-0 rounded-md px-3 py-1 text-xs font-semibold"
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
