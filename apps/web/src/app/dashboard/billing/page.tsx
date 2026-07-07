import { BILLING } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import { ManageBillingButton, UpgradeButton } from "./BillingActions";

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
}

// Free forever — the stuff that costs us nothing and hooks the shop.
const FREE_FEATURES = [
  "Digital punch cards and your loyalty menu",
  "Your branded rewards page and public mini-site",
  "Client book with notes, history, and CSV export",
  "One-tap “Log visit” for walk-ins (no booking app needed)",
  "At-risk radar: see exactly who’s overdue",
];

// Premium — the outbound layer that actually brings clients back. (Acuity/
// Square visit SYNC is free - the paid part is what we DO with the synced
// calendar: texts + your own booking page.)
const PREMIUM_FEATURES = [
  "Smart “time to rebook” texts to at-risk clients",
  "Win-back texts that recover lapsed clients automatically",
  "Your own online booking page with confirmation + reminder texts",
  "Promo blasts with results you can attribute",
  "Everything in Free, always included",
];

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: { checkout?: string };
}) {
  const res = await apiGet<BillingStatus>("/api/billing");
  const b = res.data;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <h1 className="font-display text-2xl tracking-tight">Billing</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        One plan, everything included. Cancel anytime.
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
                <p className="mt-1 font-display text-xl">
                  {b.compAccess
                    ? `${b.planName} · complimentary`
                    : b.subscribed
                      ? b.planName
                      : b.hasAccess && b.billingEnabled
                        ? "Free trial"
                        : "Free"}
                </p>
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
                    ${b.priceMonthlyUsd}
                    <span className="text-sm text-muted">/mo</span>
                  </p>
                  <p className="text-xs text-muted">first {b.trialDays} days free</p>
                </div>
              </HideInNativeApp>
            </div>

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
                      <UpgradeButton
                        label={
                          b.hasAccess
                            ? `Go Premium, $${b.priceMonthlyUsd}/mo`
                            : `Upgrade to Premium, $${b.priceMonthlyUsd}/mo`
                        }
                      />
                    )}
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
          </Card>

          <div className="grid gap-5 sm:grid-cols-2">
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
                {BILLING.planName}
                {/* Price omitted in-app (App Store 3.1.1). */}
                <HideInNativeApp> · ${BILLING.priceMonthlyUsd}/mo</HideInNativeApp>
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {PREMIUM_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-offwhite">
                    <span className="mt-0.5 text-gold">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted">
                One booked visit usually covers the month. Payments are handled by
                Stripe. We never see your card.
              </p>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
