import { PLANS } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { Card } from "@/components/ui/Card";
import { DemoTour } from "@/components/tour/DemoTour";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import {
  CancelMembershipButton,
  ManageBillingButton,
  ReceptionistAddonButton,
  UpgradeButton,
  UpgradeToPremiumAiButton,
} from "./BillingActions";
import { ReceptionistControls } from "./ReceptionistControls";

interface BillingStatus {
  billingEnabled: boolean;
  planName: string;
  priceMonthlyUsd: number;
  trialDays: number;
  plan: string;
  subscriptionStatus: string;
  subscribed: boolean;
  compAccess: boolean;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  hasAccess: boolean;
  canManage: boolean;
  smsUsage: { used: number; quota: number | null; resetsAt: string };
  premiumAi: { billingEnabled: boolean; priceMonthlyUsd: number };
  receptionist: {
    billingEnabled: boolean;
    subscriptionStatus: string;
    compAccess: boolean;
    entitled: boolean;
    included: boolean;
  };
}

interface ShopSettings {
  receptionistEnabled: boolean;
  receptionistTermsAcceptedAt: string | null;
  bookingMode: string;
  twilioNumber: string | null;
}

// Tier feature: a bold lead + an optional muted detail line, so every row
// SELLS instead of just listing. Keep details one line at card width.
interface TierFeature {
  lead: string;
  detail?: string;
}

// Free forever — the stuff that costs us nothing and hooks the shop.
const FREE_FEATURES: TierFeature[] = [
  { lead: "Digital punch cards", detail: "loyalty that runs itself, visit by visit" },
  { lead: "Branded rewards page + mini-site", detail: "your colors, your fonts, one shareable link" },
  { lead: "A client book that's YOURS", detail: "notes, history, CSV export — never locked in" },
  { lead: "One-tap visit logging", detail: "walk-ins counted, no booking app needed" },
  { lead: "At-risk radar", detail: "see who's overdue before they drift away" },
  { lead: "Free web push notifications" },
];

// Premium — the outbound layer that actually brings clients back. (Acuity/
// Square visit SYNC is free - the paid part is what we DO with the synced
// calendar: texts + your own booking page.)
const PREMIUM_FEATURES: TierFeature[] = [
  { lead: "Everything in Free, always" },
  {
    lead: `${PLANS.pro.smsMonthlyQuota} texts a month included`,
    detail: "confirmations, reminders, nudges, win-backs",
  },
  {
    lead: "Your own online booking page",
    detail: "add-ons, waitlist, recurring, per-day pricing",
  },
  {
    lead: "Smart rebooking texts",
    detail: "timed to each client's own visit rhythm",
  },
  {
    lead: "Win-backs on autopilot",
    detail: "quiet regulars get pulled back to the chair",
  },
  {
    lead: "Promo blasts with receipts",
    detail: "see the exact bookings every blast brought in",
  },
  {
    lead: "“A slot just opened” alerts",
    detail: "cancellations backfill from your waitlist",
  },
];

// Premium AI — the receptionist tier. This card has to feel like the shop
// hiring front-desk staff, not a bigger text bundle.
const PREMIUM_AI_FEATURES: TierFeature[] = [
  {
    lead: "An AI receptionist on your line 24/7",
    detail: "answers every client text in seconds — mid-cut, midnight, Monday",
  },
  {
    lead: "Books, reschedules & cancels by text",
    detail: "straight onto your real calendar, no double-booking",
  },
  {
    lead: "Refills canceled slots on its own",
    detail: "texts a regular who's due the moment a gap opens",
  },
  {
    lead: "Knows when to hand off",
    detail: "anything it can't handle comes to you with an alert",
  },
  {
    lead: "Your own local number",
    detail: "clients text YOUR shop's number, not a shared line — set up automatically",
  },
  {
    lead: `${PLANS.pro_ai.smsMonthlyQuota.toLocaleString()} texts a month — 4× Premium`,
  },
  { lead: "Everything in Premium" },
];

/** Human label for the shop's current tier state. */
function planLabel(b: BillingStatus): string {
  if (b.plan === "pro_ai") return PLANS.pro_ai.name;
  if (b.subscribed && b.receptionist.entitled && !b.receptionist.compAccess) {
    return `${PLANS.pro.name} + AI receptionist`;
  }
  if (b.compAccess) return `${b.planName} · complimentary`;
  if (b.subscribed) return b.planName;
  if (b.hasAccess && b.billingEnabled) return "Free trial";
  return "Free";
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: { checkout?: string; upgrade?: string; receptionist?: string };
}) {
  const [res, shopRes, me] = await Promise.all([
    apiGet<BillingStatus>("/api/billing"),
    apiGet<ShopSettings>("/api/shops/me"),
    // Memoized: shares the layout's /api/auth/me round-trip for this render.
    getMe(),
  ]);
  const b = res.data;
  const shop = shopRes.data;

  const currentPrice =
    b?.plan === "pro_ai" ? b.premiumAi.priceMonthlyUsd : b?.priceMonthlyUsd;
  const usagePct =
    b?.smsUsage.quota && b.smsUsage.quota > 0
      ? Math.min(100, Math.round((b.smsUsage.used / b.smsUsage.quota) * 100))
      : 0;
  const nearQuota = Boolean(
    b?.smsUsage.quota && b.smsUsage.used >= b.smsUsage.quota * 0.8,
  );
  const showMeter = Boolean(b?.smsUsage.quota && b.hasAccess);

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-10">
      {/* Barber-side guided tour (this page hosts the LAST step, so it passes
          `prospect` — read-only demo sessions finish on the signup CTA).
          data-tour: keep in sync with packages/config/src/demoTour.ts. */}
      <DemoTour tour="dashboard" route="billing" prospect={Boolean(me.data?.demo)} />
      <h1 className="font-display text-2xl tracking-tight">Billing</h1>
      {/* The plan-comparison subtitle is a subscription pitch — hidden in-app
          (App Store 3.1.1). In-app this page shows only price-free account
          status (current plan + text usage), never the paid tiers. */}
      <p className="mb-6 mt-1 text-sm text-muted">
        <HideInNativeApp>Simple tiers, no per-text surprises. Cancel anytime.</HideInNativeApp>
        <ShowInNativeApp>Your plan and text usage.</ShowInNativeApp>
      </p>

      {searchParams?.checkout === "success" && (
        <div className="mb-5 rounded-2xl border border-emerald-soft/40 bg-emerald-soft/10 px-4 py-3 text-sm text-emerald-soft">
          You&apos;re subscribed. Welcome aboard. Your nudges and promos are live.
        </div>
      )}
      {searchParams?.checkout === "canceled" && (
        <div className="mb-5 rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3 text-sm text-muted">
          Checkout canceled. No charge was made.
        </div>
      )}
      {searchParams?.upgrade === "success" && (
        <div className="mb-5 rounded-2xl border border-emerald-soft/40 bg-emerald-soft/10 px-4 py-3 text-sm text-emerald-soft">
          Upgraded to Premium AI. Turn on your receptionist below.
        </div>
      )}
      {searchParams?.receptionist === "success" && (
        <div className="mb-5 rounded-2xl border border-emerald-soft/40 bg-emerald-soft/10 px-4 py-3 text-sm text-emerald-soft">
          AI receptionist added. Turn it on below when you&apos;re ready.
        </div>
      )}

      {!b ? (
        <Card className="p-6 text-sm text-danger-soft">
          Couldn&apos;t load billing status. Refresh to try again.
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Card className="p-6">
            <div
              data-tour="plan"
              className="flex flex-wrap items-start justify-between gap-4"
            >
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-muted">
                  Current plan
                </p>
                <p className="mt-1 font-display text-xl">{planLabel(b)}</p>
                <p className="mt-1 text-sm text-muted">
                  {b.compAccess
                    ? "Full access, on the house. No card needed, enjoy everything."
                    : b.subscribed
                      ? b.subscriptionStatus === "past_due"
                        ? "Payment issue. Update your card to keep texts flowing."
                        : "Active. Thanks for building with us."
                      : !b.billingEnabled
                        ? "Early access: everything is free right now."
                        : b.hasAccess
                          ? `${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"} of full Premium left. No card on file.`
                          : "Your punch cards, rewards page, and client book are free forever. Upgrade to Premium to text clients."}
                </p>
              </div>
              {/* Price is hidden in-app: the App Store forbids showing prices
                  or purchase CTAs for out-of-app (Stripe) billing (3.1.1). */}
              <HideInNativeApp>
                <div className="text-right">
                  <p className="font-display text-3xl text-gold">
                    ${currentPrice}
                    <span className="text-sm text-muted">/mo</span>
                  </p>
                  <p className="text-xs text-muted">first {b.trialDays} days free</p>
                </div>
              </HideInNativeApp>
            </div>

            {/* Monthly text usage meter (fine to show natively - no price). */}
            {showMeter && (
              <div className="mt-5 rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-offwhite">Texts this month</span>
                  <span className={nearQuota ? "text-danger-soft" : "text-muted"}>
                    {b.smsUsage.used.toLocaleString()} /{" "}
                    {b.smsUsage.quota!.toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-charcoal-900">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ease-out ${
                      usagePct >= 100
                        ? "bg-danger-soft"
                        : usagePct >= 80
                          ? "bg-gold"
                          : "bg-gold-gradient"
                    }`}
                    style={{ width: `${usagePct}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-muted">
                  Resets{" "}
                  {new Date(b.smsUsage.resetsAt).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                  })}
                  . Booking confirmations, reminders about real appointments, and
                  replies in live conversations never count.
                </p>
                {nearQuota && b.plan !== "pro_ai" && (
                  <p className="mt-1 text-xs text-gold">
                    Running low? Premium AI includes{" "}
                    {PLANS.pro_ai.smsMonthlyQuota.toLocaleString()} texts a month.
                  </p>
                )}
              </div>
            )}

            {!b.compAccess && !b.hasAccess && b.billingEnabled && (
              // Premium-upsell copy is hidden in-app (3.1.1) — barbers see plans
              // and upgrade on the web.
              <HideInNativeApp>
                <div className="mt-4 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold">
                  You&apos;re on the Free plan. Punches, your rewards page, and your
                  client book keep working. Premium adds the part that brings clients
                  back: rebooking texts and promo blasts.
                </div>
              </HideInNativeApp>
            )}

            {/* Comped shops have everything already; no billing surface. */}
            {!b.compAccess && (
              <>
                {/* Account management only — the buy/upgrade buttons live on
                    the tier cards below, where the comparison is. All of it is
                    hidden in-app per App Store Guideline 3.1.1. */}
                <HideInNativeApp>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {b.canManage && <ManageBillingButton />}
                    {/* Cancel: visible, honest, still calm — a real button
                        next to Manage billing, with its own 2-tap confirm. */}
                    {b.subscribed && <CancelMembershipButton />}
                  </div>
                  {b.billingEnabled && !b.subscribed && (
                    <p className="mt-5 text-sm text-muted">
                      Ready to grow?{" "}
                      <span className="text-offwhite">
                        Pick your plan below
                      </span>{" "}
                      — every tier keeps your loyalty program and client book
                      free forever.
                    </p>
                  )}
                </HideInNativeApp>
                <ShowInNativeApp>
                  <p className="mt-5 rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3 text-sm text-muted">
                    Manage your plan and payment from{" "}
                    <span className="text-offwhite">getchairback.com</span> in your
                    web browser.
                  </p>
                </ShowInNativeApp>
              </>
            )}

            {/* Receptionist on/off + one-time liability acknowledgment, once
                entitled (tier, add-on, or comped pilot). No price shown, so it
                can render natively too. */}
            {b.receptionist.entitled && shop && (
              <ReceptionistControls
                enabled={shop.receptionistEnabled}
                termsAccepted={shop.receptionistTermsAcceptedAt !== null}
                bookingMode={shop.bookingMode}
                shopNumber={shop.twilioNumber ?? null}
              />
            )}
          </Card>

          {/* The plan switcher: every card carries its own state-aware action
              (current-plan chip / upgrade / checkout), so switching tiers or
              comparing them never requires hunting elsewhere on the page.
              The ENTIRE tier comparison is hidden in-app, not just the prices
              and buttons: a three-plan subscription grid — even price-free — is
              exactly the "access to subscription mechanisms" App Store 3.1.1
              forbids in-app. Barbers compare and pick plans on the web. */}
          <HideInNativeApp>
          <div className="grid items-stretch gap-5 sm:grid-cols-3">
            <Card className="flex flex-col p-6">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-muted">
                  Free, always
                </p>
                {!b.subscribed && b.plan !== "pro_ai" && (
                  <span className="rounded-full border border-subtle px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted">
                    Your plan today
                  </span>
                )}
              </div>
              <ul className="mt-3 flex flex-col gap-2.5">
                {FREE_FEATURES.map((item) => (
                  <li key={item.lead} className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm text-muted">✓</span>
                    <span>
                      <span className="block text-sm text-offwhite">{item.lead}</span>
                      {item.detail && (
                        <span className="block text-xs text-muted">{item.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="relative flex flex-col border-gold/30 p-6">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-gold-soft">
                  {PLANS.pro.name}
                  {/* Price omitted in-app (App Store 3.1.1). */}
                  <HideInNativeApp> · ${PLANS.pro.priceMonthlyUsd}/mo</HideInNativeApp>
                </p>
                {b.subscribed && b.plan === "pro" ? (
                  <span className="rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] uppercase tracking-wide text-emerald-soft">
                    Current plan
                  </span>
                ) : (
                  <span className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] uppercase tracking-wide text-gold">
                    Most popular
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-offwhite">
                The part that brings clients back.
              </p>
              <ul className="mt-3 flex flex-col gap-2.5">
                {PREMIUM_FEATURES.map((item) => (
                  <li key={item.lead} className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm text-gold">✓</span>
                    <span>
                      <span className="block text-sm text-offwhite">{item.lead}</span>
                      {item.detail && (
                        <span className="block text-xs text-muted">{item.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {!b.compAccess && b.billingEnabled && !b.subscribed && (
                <HideInNativeApp>
                  <div className="mt-5 pt-1">
                    <UpgradeButton
                      tier="pro"
                      label={`Go Premium — $${b.priceMonthlyUsd}/mo`}
                    />
                  </div>
                </HideInNativeApp>
              )}
            </Card>

            {/* Premium AI — the showcase card. This should read like hiring
                front-desk staff for the price of a few cuts, not like a
                bigger text bundle. */}
            <Card className="relative flex flex-col overflow-hidden border-gold/60 p-6 shadow-glow">
              <div
                className="pointer-events-none absolute inset-0 bg-gradient-to-b from-gold/10 via-transparent to-transparent"
                aria-hidden
              />
              <div className="relative flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-gold">
                  {PLANS.pro_ai.name}
                  {/* Price omitted in-app (App Store 3.1.1). */}
                  <HideInNativeApp> · ${PLANS.pro_ai.priceMonthlyUsd}/mo</HideInNativeApp>
                </p>
                {b.plan === "pro_ai" ? (
                  <span className="rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] uppercase tracking-wide text-emerald-soft">
                    Current plan
                  </span>
                ) : (
                  <span className="rounded-full bg-gold-gradient px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-charcoal">
                    Most powerful
                  </span>
                )}
              </div>
              <p className="relative mt-2 font-display text-lg text-offwhite">
                Your shop answers its own texts.
              </p>
              <ul className="relative mt-3 flex flex-col gap-2.5">
                {PREMIUM_AI_FEATURES.map((item) => (
                  <li key={item.lead} className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm text-gold">✓</span>
                    <span>
                      <span className="block text-sm text-offwhite">{item.lead}</span>
                      {item.detail && (
                        <span className="block text-xs text-muted">{item.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {/* One tiny live exchange — the wow is SEEING it work. */}
              <div className="relative mt-4 flex flex-col gap-1.5 rounded-xl bg-charcoal-900/60 p-3">
                <div className="self-start rounded-2xl rounded-bl-sm bg-charcoal-700 px-3 py-1.5 text-xs text-offwhite">
                  you got anything saturday?
                </div>
                <div className="self-end rounded-2xl rounded-br-sm bg-gold/15 px-3 py-1.5 text-xs text-offwhite">
                  2pm or 4pm — want me to grab one?
                </div>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted">
                  Answered, booked, confirmed — while you were cutting.
                </p>
              </div>

              <div className="relative mt-auto">
                <HideInNativeApp>
                  <p className="mt-4 text-xs text-gold-soft">
                    One filled cancellation usually covers the month. The rest
                    is profit.
                  </p>
                  {!b.compAccess && (
                    <div className="mt-3">
                      {b.plan !== "pro_ai" &&
                        b.subscribed &&
                        !b.receptionist.entitled &&
                        (b.premiumAi.billingEnabled ? (
                          <UpgradeToPremiumAiButton
                            label={`Upgrade now — $${b.premiumAi.priceMonthlyUsd}/mo`}
                          />
                        ) : b.receptionist.billingEnabled ? (
                          <ReceptionistAddonButton label="Add the AI receptionist, $40/mo" />
                        ) : (
                          <p className="text-xs text-muted">
                            Almost here — check back soon.
                          </p>
                        ))}
                      {b.subscribed &&
                        b.plan !== "pro_ai" &&
                        b.receptionist.entitled && (
                          <p className="text-xs text-muted">
                            You already have the AI receptionist via your add-on
                            — same power, nothing more to buy.
                          </p>
                        )}
                      {b.billingEnabled &&
                        !b.subscribed &&
                        (b.premiumAi.billingEnabled ? (
                          <UpgradeButton
                            tier="pro_ai"
                            label={`Go Premium AI — $${b.premiumAi.priceMonthlyUsd}/mo`}
                          />
                        ) : (
                          <p className="text-xs text-muted">
                            Almost here — check back soon.
                          </p>
                        ))}
                    </div>
                  )}
                  <p className="mt-3 text-[11px] text-muted">
                    Payments handled by Stripe. We never see your card. Cancel
                    anytime.
                  </p>
                </HideInNativeApp>
              </div>
            </Card>
          </div>
          </HideInNativeApp>
        </div>
      )}
    </main>
  );
}
