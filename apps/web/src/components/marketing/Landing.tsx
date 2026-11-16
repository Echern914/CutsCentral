import Link from "next/link";
import { APP_NAME, BILLING, PLANS } from "@chairback/config/constants";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { HeroPhone, WeekPreview } from "./LandingVisuals";
import { CheckIcon, PricingSection } from "./PricingSection";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { Testimonials } from "./Testimonials";

/**
 * The marketing homepage (the "Studio" redesign, 2026-11). A server component
 * with no client JavaScript of its own: the product pictures are static
 * markup, so the page streams fast and renders fully for search engines.
 *
 * 🔴 Every claim here is something a shop can switch on today. Texting is off
 * in production, so nothing promises a text; reminders are app notifications
 * and email. The testimonials section renders nothing until there is a real
 * quote (see Testimonials.tsx), and prices come from PLANS, never a literal.
 */

const BTN =
  "inline-flex min-h-[48px] items-center justify-center rounded-xl px-6 text-base font-semibold transition-colors duration-150 ease-out";
const BTN_PRIMARY = `${BTN} bg-primary text-on-primary hover:bg-primary/90`;
const BTN_OUTLINE = `${BTN} border border-subtle-strong bg-charcoal-800 text-offwhite hover:bg-charcoal-700`;
const EYEBROW = "text-sm font-semibold text-gold";
const H2 =
  "font-display text-[32px] leading-[38px] tracking-[-0.025em] [text-wrap:balance] sm:text-[44px] sm:leading-[50px]";

export function Landing() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-charcoal-900">
      <SiteHeader />

      <main>
        {/* ====== Hero ====== */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pb-20 pt-12 sm:pt-16 lg:grid-cols-2 lg:pb-24 lg:pt-20">
          <div className="min-w-0">
            <p className={EYEBROW}>For barbershops, salons and studios</p>
            <h1 className="mt-3.5 font-display text-[44px] leading-[48px] tracking-[-0.035em] [text-wrap:balance] sm:text-[68px] sm:leading-[72px]">
              Keep your chair full.
            </h1>
            <p className="mt-5 max-w-[500px] text-lg leading-7 text-muted">
              Clients book in a few taps, pay up front when you ask them to, and
              come back for their punch card. You run the whole day from one
              screen.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className={BTN_PRIMARY}>
                Start free
              </Link>
              <Link href="/demo" className={BTN_OUTLINE}>
                See the demo
              </Link>
            </div>
            <p className="mt-4 text-sm text-muted">
              {BILLING.trialDays} days free, no card
            </p>
          </div>
          <HeroPhone />
        </section>

        {/* ====== Where clients come from ====== */}
        <div className="border-y border-subtle bg-charcoal-800">
          <p className="mx-auto flex min-h-[72px] w-full max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-6 py-4 text-center text-[15px] text-muted">
            <span>Bring your clients from</span>
            <span className="font-semibold text-offwhite">Acuity</span>
            <span className="font-semibold text-offwhite">Square</span>
            <span>or start fresh on {APP_NAME} booking</span>
          </p>
        </div>

        {/* ====== What you get ====== */}
        <section id="features" className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-20 sm:py-24">
          <div className="max-w-2xl">
            <p className={EYEBROW}>What you get</p>
            <h2 className={`mt-2.5 ${H2}`}>Less chasing. More cutting.</h2>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-subtle bg-charcoal-800 p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gold/15 text-gold">
                  {f.icon}
                </span>
                <h3 className="mt-[18px] font-display text-[22px] leading-7">{f.title}</h3>
                <p className="mt-1.5 text-muted">{f.body}</p>
              </div>
            ))}
          </div>
          <ul className="mt-10 grid gap-x-8 gap-y-3 text-[15px] sm:grid-cols-2 lg:grid-cols-3">
            {ALSO.map((a) => (
              <li key={a} className="flex items-start gap-2.5">
                <CheckIcon className="mt-1 h-4 w-4 shrink-0 text-gold" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ====== Phone and desk ====== */}
        <section className="border-y border-subtle bg-charcoal-800">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-20 sm:py-24">
            <div className="max-w-3xl">
              <p className={EYEBROW}>On any screen</p>
              <h2 className={`mt-2.5 ${H2}`}>
                Run the day from your phone. Plan the week from your desk.
              </h2>
            </div>
            <WeekPreview />
            <ol className="grid gap-6 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-subtle-strong font-display tabular-nums">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{s.title}</span>
                    <span className="block text-muted">{s.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ====== Testimonials (renders nothing until a real quote exists) ====== */}
        <Testimonials />

        {/* ====== Pricing (shared with /pricing; hides itself in-app) ====== */}
        <PricingSection />

        {/* ====== FAQ ====== */}
        <section className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
          <p className={EYEBROW}>FAQ</p>
          <h2 className={`mt-2.5 ${H2}`}>Quick answers.</h2>
          <div className="mt-8 divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-charcoal-800">
            {FAQ.map((f) => {
              const item = (
                <details key={f.q} className="group">
                  <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 font-medium [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <PlusIcon className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 ease-out group-open:rotate-45" />
                  </summary>
                  <p className="px-5 pb-5 text-[15px] leading-relaxed text-muted">{f.a}</p>
                </details>
              );
              // The cost answer carries plan prices, forbidden in-app (3.1.1).
              return f.hasPrices ? (
                <HideInNativeApp key={f.q}>{item}</HideInNativeApp>
              ) : (
                item
              );
            })}
          </div>
        </section>

        {/* ====== Final call to action: the one inverted band ====== */}
        <section className="bg-primary text-on-primary">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-8 px-6 py-20">
            <div className="min-w-0">
              <h2 className={H2}>Your chair, full.</h2>
              <p className="mt-3 text-lg leading-7 opacity-75">
                Bring your clients with you. The first {BILLING.trialDays} days are on us.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/signup"
                className={`${BTN} bg-charcoal-900 text-offwhite hover:bg-charcoal-800`}
              >
                Start free
              </Link>
              <a
                href="mailto:support@getchairback.com"
                className={`${BTN} border border-on-primary/30 hover:bg-on-primary/10`}
              >
                Talk to us
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

/* ====== content ====== */

const FEATURES = [
  {
    title: "A calendar that fills itself",
    body: "When someone cancels, the opening goes to your waitlist and your best clients first, so the gap closes before you notice it.",
    icon: <CalendarCheckIcon className="h-[22px] w-[22px]" />,
  },
  {
    title: "Paid before they sit down",
    body: "Deposits at booking, a saved card for late cancels, and one checkout for the balance, the tip and cash.",
    icon: <CardIcon className="h-[22px] w-[22px]" />,
  },
  {
    title: "Rewards that bring them back",
    body: "A punch card your clients keep in Apple Wallet, and tiers that give your regulars first pick of an opening.",
    icon: <MedalIcon className="h-[22px] w-[22px]" />,
  },
] as const;

const ALSO = [
  "Rebooking reminders timed to each client's own rhythm",
  "Clients drifting past their usual gap, flagged before they're gone",
  "Saturday and holiday prices, shown before anyone books",
  "Card payments into your own Stripe, with 0% booking commission",
  "Your own domain, and a page Google can read",
  "Import from Acuity or Square, export to CSV any time",
] as const;

const STEPS = [
  {
    title: "Bring your clients",
    body: "Import from Acuity or Square, or add them as they book.",
  },
  {
    title: "Share your link",
    body: "In your bio, on a QR code at your station, anywhere.",
  },
  {
    title: "Get paid and rebooked",
    body: "Check out after the visit and book the next one before they leave.",
  },
] as const;

// `hasPrices` marks answers that carry plan pricing, hidden in-app (3.1.1).
const FAQ: readonly { q: string; a: string; hasPrices?: boolean }[] = [
  {
    q: "Do my clients need to download an app?",
    a: "Not for their punch card. Each client gets a private magic link that opens in the browser, with no account and no password. Rebooking and win-back reminders go out as app notifications, so those reach clients who have the app.",
  },
  {
    q: "Does it work with my existing Acuity account?",
    a: "Yes. You connect Acuity once with one click. Past appointments backfill automatically, new ones flow in as they happen, and synced visits earn punches just like native bookings — you don't have to move your booking anywhere.",
  },
  {
    q: "Can I use my own domain?",
    a: "Yes. Connect a domain you own from your page settings and anyone who types it lands straight on your booking page. We show you the two records to add wherever you bought it (GoDaddy, Namecheap, and so on) — most domains connect in minutes.",
  },
  {
    q: "Will clients find me on Google?",
    a: "Your page carries the structured business info Google reads — your name, address, hours, photos, and reviews — so once your address is filled in, your shop can surface for local searches. Own a domain? Connect it and it points people straight to your page.",
  },
  {
    q: "What counts as a punch?",
    a: "Completed appointments. Cancellations and no-shows never earn punches, so cards stay honest.",
  },
  {
    q: "What if a client doesn't want to hear from me?",
    a: "Every marketing email carries an unsubscribe link, and clients control app notifications from their own phone.",
  },
  {
    q: "I'm not on Acuity, can I still use it?",
    a: "Yes. Add clients in seconds and tap “Log visit” after each appointment: punches, rewards, and rebooking reminders all work the same. Acuity just makes it automatic, and you can connect it anytime.",
  },
  {
    q: "How much does it cost?",
    a: `Two plans. Starter ($${PLANS.starter.priceMonthlyUsd}/month) is your online booking page, calendar, client book, punch cards and email confirmations, with a preview of Insights. Premium ($${PLANS.pro.priceMonthlyUsd}/month, ${PLANS.pro.emailMonthlyQuota.toLocaleString()} client emails a month) adds what brings clients back - rebooking and win-back reminders by app notification, and waitlist alerts - plus the full Insights picture. Every new shop gets all of Premium free for ${BILLING.trialDays} days, and one rebooked regular typically covers the month.`,
    hasPrices: true,
  },
  {
    q: "Is it only for barbershops?",
    a: "No. Salons, nail studios, lash artists, spas, and tattoo studios run the exact same playbook: visits earn punches, drifting clients land on your radar. Pick your industry at signup and the defaults match your business.",
  },
];

/* ====== inline icons (no extra deps) ====== */

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CalendarCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
    </svg>
  );
}

function CardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </svg>
  );
}

function MedalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5" />
    </svg>
  );
}
