import Link from "next/link";
import { BILLING, PLANS } from "@chairback/config/constants";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

/**
 * The two-plan pricing grid, shared by the landing page (#pricing section)
 * and the standalone /pricing page. The HideInNativeApp wrapper lives INSIDE
 * so no caller can accidentally render plan prices in the iOS WebView (App
 * Store 3.1.1) - in-app this renders nothing at all.
 *
 * Starter is the way in for a shop that wants online booking and nothing
 * outbound; Premium is the plan that brings clients back (reminders + the full
 * analysis). Every new shop trials all of Premium for BILLING.trialDays days and
 * then picks one.
 *
 * 🔴 Texting is off and staying off, and Premium AI is no longer sold (Eric,
 * 2026-11-08). Neither belongs here: promising them is how a shop pays for
 * something that never arrives.
 */

const CHECK = "mt-0.5 h-4 w-4 shrink-0 text-gold";

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
                <span className="text-gradient-gold">Pick the plan that pays for itself.</span>
              </>
            }
            sub={`Every new shop gets the whole thing free for ${BILLING.trialDays} days — no card, nothing to cancel. Then keep everything from $${PLANS.starter.priceMonthlyUsd} a month.`}
          />
          <Reveal delay={0.1} className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
            {/* Starter */}
            <div className="glass relative flex flex-col overflow-hidden rounded-3xl border border-subtle p-8">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.25em] text-muted">
                  {PLANS.starter.name}
                </p>
              </div>
              <p className="mt-4 font-display text-5xl tracking-tight">
                ${PLANS.starter.priceMonthlyUsd}
                <span className="text-lg text-muted">/month</span>
              </p>
              <p className="mt-2 text-sm text-muted">
                Take bookings online and reward your regulars.
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-left text-sm text-offwhite">
                {[
                  "Your own online booking page + calendar",
                  "Email confirmations & reminders, add-to-calendar, Apple Wallet",
                  `${PLANS.starter.emailMonthlyQuota.toLocaleString()} client emails a month`,
                  "Digital punch cards, rewards & your branded loyalty page",
                  "Client book, notes & CSV import/export",
                  "Your public mini-site on your own domain",
                  "Card & Apple Pay at booking, or Zelle / Venmo / Cash App — 0% commission",
                  "Insights preview: the headline numbers",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <CheckIcon className={CHECK} />
                    {t}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-7 inline-flex items-center justify-center gap-2 rounded-full border border-subtle-strong px-7 py-3 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Start your free trial
                <ArrowIcon className="h-4 w-4" />
              </Link>
            </div>

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
                Everything in Starter, plus what brings clients back.
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-left text-sm text-offwhite">
                {[
                  `${PLANS.pro.emailMonthlyQuota.toLocaleString()} client emails a month`,
                  "Full Insights: trends, services, booked vs open hours, goals & the yearly report",
                  "Smart rebooking reminders, timed per client, by app notification",
                  "Win-back reminders for quiet clients, by app notification",
                  "Waitlist with “a slot just opened” alerts by email and app",
                  "Holiday, weekend & time-of-day pricing, plus special-priced slots",
                  "Square & Acuity sync",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <CheckIcon className={CHECK} />
                    {t}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-7 inline-flex items-center justify-center gap-2 rounded-full bg-gold-gradient px-7 py-3 text-sm font-semibold text-on-gold shadow-glow transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
              >
                Start your free trial
                <ArrowIcon className="h-4 w-4" />
              </Link>
            </div>

          </Reveal>
          <p className="mx-auto mt-6 max-w-md text-center text-xs text-muted">
            No contracts, cancel anytime, switch plans whenever you like. The
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
