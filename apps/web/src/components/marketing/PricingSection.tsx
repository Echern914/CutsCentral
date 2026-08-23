import Link from "next/link";
import { BILLING, PLANS } from "@chairback/config/constants";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

/**
 * The three-plan pricing grid, shared by the landing page (#pricing section)
 * and the standalone /pricing page. The HideInNativeApp wrapper lives INSIDE
 * so no caller can accidentally render plan prices in the iOS WebView (App
 * Store 3.1.1) - in-app this renders nothing at all.
 */
export function PricingSection() {
  return (
    <HideInNativeApp>
      <section id="pricing" className="border-t border-subtle bg-charcoal-900/40">
        <div className="mx-auto w-full max-w-6xl px-6 py-24">
          <SectionHeading
            eyebrow="Pricing"
            title={
              <>
                Start free.{" "}
                <span className="text-gradient-gold">Upgrade when it pays for itself.</span>
              </>
            }
            sub={`One plan, everything in it. Try the whole thing free for ${BILLING.trialDays} days — no card, nothing to cancel. One rebooked regular covers the month.`}
          />
          <Reveal delay={0.1} className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
            {/* Premium */}
            <div className="glass relative flex flex-col overflow-hidden rounded-3xl border border-gold/30 p-8">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-48 rounded-full bg-gold/15 blur-3xl"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.25em] text-gold-soft">
                  {PLANS.pro.name}
                </p>
                <span className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gold">
                  Most popular
                </span>
              </div>
              <p className="mt-4 font-display text-5xl tracking-tight">
                ${PLANS.pro.priceMonthlyUsd}
                <span className="text-lg text-muted">/month</span>
              </p>
              <p className="mt-2 text-sm text-muted">
                Everything ChairBack does, from day one.{" "}
                {BILLING.trialDays}-day free trial, no card.
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-left text-sm text-offwhite">
                {[
                  `${PLANS.pro.smsMonthlyQuota} texts a month included`,
                  "Digital punch cards, rewards & your branded loyalty page",
                  "Client book, notes & CSV import/export",
                  "Your public mini-site on your own domain",
                  "Your own online booking page + confirmation & reminder texts and emails",
                  "Smart rebooking texts, timed per client",
                  "Win-back texts that recover lapsed clients",
                  "Promo blasts with revenue attribution",
                  "Waitlist with “a slot just opened” alerts",
                  "Recurring appointments, add-ons & request approval",
                  "Holiday, weekend & time-of-day pricing, plus special-priced slots",
                  "Square & Acuity sync — reminder texts cover synced bookings too",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-7 inline-flex items-center justify-center gap-2 rounded-full bg-gold-gradient px-7 py-3 text-sm font-semibold text-charcoal shadow-glow transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
              >
                Start your free trial
                <ArrowIcon className="h-4 w-4" />
              </Link>
            </div>

            {/* Premium AI */}
            <div className="glass relative flex flex-col overflow-hidden rounded-3xl border border-gold/50 p-8">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-48 rounded-full bg-gold/20 blur-3xl"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.25em] text-gold">
                  {PLANS.pro_ai.name}
                </p>
                <span className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gold">
                  New
                </span>
              </div>
              <p className="mt-4 font-display text-5xl tracking-tight">
                ${PLANS.pro_ai.priceMonthlyUsd}
                <span className="text-lg text-muted">/month</span>
              </p>
              <p className="mt-2 text-sm text-muted">
                Everything in Premium, plus an AI receptionist on your line
                around the clock.
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-left text-sm text-offwhite">
                {[
                  "AI receptionist answers client texts 24/7",
                  "Books, reschedules & cancels by text",
                  "Fills freed slots automatically when someone cancels",
                  `${PLANS.pro_ai.smsMonthlyQuota.toLocaleString()} texts a month included`,
                  "Everything in Premium",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-7 inline-flex items-center justify-center gap-2 rounded-full border border-gold/50 px-7 py-3 text-sm font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
              >
                Start your free trial
                <ArrowIcon className="h-4 w-4" />
              </Link>
            </div>
          </Reveal>
          <p className="mx-auto mt-6 max-w-md text-center text-xs text-muted">
            Generous monthly text allowances, no contracts, cancel anytime. The
            average shop recovers several no-show-again clients a month: the
            whole bill, many times over.
          </p>
        </div>
      </section>
    </HideInNativeApp>
  );
}

/* Shared marketing icons (also used by the landing page outside pricing). */

export function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
