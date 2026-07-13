import { PLANS } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import {
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
}

// Free forever — the stuff that costs us nothing and hooks the shop.
const FREE_FEATURES = [
  "Digital punch cards and your loyalty menu",
  "Your branded rewards page and public mini-site",
  "Client book with notes, history, and CSV export",
  "One-tap “Log visit” for walk-ins (no booking app needed)",
  "At-risk radar: see exactly who’s overdue",
  "Free web push notifications to installed devices",
];

// Premium — the outbound layer that actually brings clients back. (Acuity/
// Square visit SYNC is free - the paid part is what we DO with the synced
// calendar: texts + your own booking page.)
const PREMIUM_FEATURES = [
  "Everything in Free, always included",
  `${PLANS.pro.smsMonthlyQuota} texts a month included`,
  "Your own online booking page with confirmation + reminder texts and emails",
  "Smart “time to rebook” texts to at-risk clients",
  "Win-back texts that recover lapsed clients automatically",
  "Promo blasts with results you can attribute",
  "Waitlist with “a slot just opened” alerts",
  "Recurring appointments, add-ons, day pricing, and request approval",
];

// Premium AI — Premium plus the receptionist and a bigger text allowance.
const PREMIUM_AI_FEATURES = [
  "Everything in Premium",
  "AI receptionist answers client texts 24/7",
  "Books, reschedules, and cancels appointments by text",
  "Automatically offers freed slots when someone cancels",
  `${PLANS.pro_ai.smsMonthlyQuota.toLocaleString()} texts a month included`,
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
  const [res, shopRes] = await Promise.all([
    apiGet<BillingStatus>("/api/billing"),
    apiGet<ShopSettings>("/api/shops/me"),
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
      <h1 className="font-display text-2xl tracking-tight">Billing</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        Simple tiers, no per-text surprises. Cancel anytime.
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
            <div className="flex flex-wrap items-start justify-between gap-4">
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
              <div className="mt-4 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold">
                You&apos;re on the Free plan. Punches, your rewards page, and your
                client book keep working. Premium adds the part that brings clients
                back: rebooking texts and promo blasts.
              </div>
            )}

            {/* Comped shops have everything already; no checkout CTA. */}
            {!b.compAccess && (
              <>
                {/* Purchase CTAs (Stripe Checkout / Customer Portal) are hidden
                    in-app per App Store Guideline 3.1.1. Barbers manage billing
                    in a browser at getchairback.com. */}
                <HideInNativeApp>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {b.billingEnabled && !b.subscribed && (
                      <>
                        <UpgradeButton
                          tier="pro"
                          label={
                            b.hasAccess
                              ? `Go Premium, $${b.priceMonthlyUsd}/mo`
                              : `Upgrade to Premium, $${b.priceMonthlyUsd}/mo`
                          }
                        />
                        {b.premiumAi.billingEnabled && (
                          <UpgradeButton
                            tier="pro_ai"
                            variant="secondary"
                            label={`Go Premium AI, $${b.premiumAi.priceMonthlyUsd}/mo`}
                          />
                        )}
                      </>
                    )}
                    {b.subscribed &&
                      b.plan !== "pro_ai" &&
                      !b.receptionist.entitled &&
                      (b.premiumAi.billingEnabled ? (
                        <UpgradeToPremiumAiButton
                          label={`Upgrade to Premium AI, $${b.premiumAi.priceMonthlyUsd}/mo`}
                        />
                      ) : (
                        b.receptionist.billingEnabled && (
                          <ReceptionistAddonButton label="Add the AI receptionist, $40/mo" />
                        )
                      ))}
                    {b.canManage && <ManageBillingButton />}
                  </div>
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
              />
            )}
          </Card>

          <div className="grid gap-5 sm:grid-cols-3">
            <Card className="p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                Free, always
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {FREE_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-offwhite">
                    <span className="mt-0.5 text-muted">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="border-gold/30 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-gold-soft">
                {PLANS.pro.name}
                {/* Price omitted in-app (App Store 3.1.1). */}
                <HideInNativeApp> · ${PLANS.pro.priceMonthlyUsd}/mo</HideInNativeApp>
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {PREMIUM_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-offwhite">
                    <span className="mt-0.5 text-gold">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="border-gold/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-gold">
                {PLANS.pro_ai.name}
                {/* Price omitted in-app (App Store 3.1.1). */}
                <HideInNativeApp> · ${PLANS.pro_ai.priceMonthlyUsd}/mo</HideInNativeApp>
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {PREMIUM_AI_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-offwhite">
                    <span className="mt-0.5 text-gold">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted">
                One filled cancellation usually covers the month. Payments are
                handled by Stripe. We never see your card.
              </p>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
