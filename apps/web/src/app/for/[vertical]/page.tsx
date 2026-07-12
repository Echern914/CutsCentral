import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { APP_NAME, BILLING } from "@chairback/config/constants";

/**
 * Vertical landing pages (/for/salons, /for/nails, ...). The homepage stays
 * barber-first (the beachhead); these give the marketer a sharp pitch per
 * vertical and pick up "loyalty program for nail salons"-style searches.
 * Static, no client JS - they render instantly and SEO-index cleanly.
 */

interface VerticalCopy {
  label: string;
  industryKey: string;
  headline: [string, string]; // plain + gold-gradient halves
  sub: string;
  rhythm: string; // the visit-cadence hook
  points: { title: string; body: string }[];
  rewardExample: string;
}

const VERTICALS: Record<string, VerticalCopy> = {
  salons: {
    label: "Hair salons",
    industryKey: "salon",
    headline: ["Keep every chair", "booked solid."],
    sub: "Automatic loyalty punch cards and perfectly-timed “time for a touch-up” texts for salons. No paper cards, no front-desk follow-up lists.",
    rhythm:
      "Color clients run on 6-8 week cycles, cuts on 4-6. ChairBack learns each guest's real rhythm and texts them right when roots and split ends do the selling for you.",
    points: [
      {
        title: "Every service earns automatically",
        body: "Connect your booking calendar (or tap once at checkout) and each completed appointment adds a punch. Color can earn more than a trim: your rules.",
      },
      {
        title: "Win back lapsed guests",
        body: "Guests drifting past their usual gap surface on your radar and get one well-worded text with your booking link. No blast, no spam.",
      },
      {
        title: "Your salon, your brand",
        body: "A branded rewards card and a public mini-site with your photos, hours, and live promotions, with no app for guests to download.",
      },
    ],
    rewardExample: "“8 visits = free blowout” or “$20 off your 6th color”",
  },
  nails: {
    label: "Nail studios",
    industryKey: "nails",
    headline: ["Fills that come back", "like clockwork."],
    sub: "Digital punch cards and smart rebooking texts for nail techs and studios. Built for 2-3 week fill cycles.",
    rhythm:
      "Nails are the perfect loyalty business: a fill every two to three weeks, all year. ChairBack counts every set and fill, and nudges clients the moment they start stretching past their cycle.",
    points: [
      {
        title: "Punch cards without the punch card",
        body: "Every completed appointment counts itself. Clients watch their card fill from a magic link, no app, no password.",
      },
      {
        title: "Slow-week promo blasts",
        body: "Tuesday looking empty? Blast a “$5 off this week” promo to opted-in clients and see exactly who redeemed.",
      },
      {
        title: "Works with or without a booking app",
        body: "On Acuity it's fully automatic. On anything else, logging a visit is one tap at the dryer station.",
      },
    ],
    rewardExample: "“10 fills = free manicure” or “free nail art on your 5th visit”",
  },
  lashes: {
    label: "Lash & brow artists",
    industryKey: "lashes",
    headline: ["Lash fills,", "on autopilot."],
    sub: "Loyalty and rebooking texts tuned for lash and brow studios, where a missed fill means a full set, and a lost client.",
    rhythm:
      "Your clients should be back every 2-3 weeks. When someone slips past their fill window, ChairBack sends one perfectly-timed text before they end up needing (and shopping around for) a new full set.",
    points: [
      {
        title: "Protect the fill cycle",
        body: "Each client's personal rhythm is learned from their history. The at-risk radar shows who's overdue today, not after they're gone.",
      },
      {
        title: "Rewards they can see",
        body: "A private magic-link card shows punches and what they're working toward: a free fill, a brow lamination, your call.",
      },
      {
        title: "Set up between clients",
        body: "Five minutes on your phone: name, reward, booking link. Done before your next appointment walks in.",
      },
    ],
    rewardExample: "“6 fills = free lash fill” or “free brow wax on visit 4”",
  },
  spas: {
    label: "Spas & skincare studios",
    industryKey: "spa",
    headline: ["Turn one-time facials", "into monthly rituals."],
    sub: "Membership-feel loyalty without the membership software. Punch cards, rebooking nudges, and promos for estheticians and day spas.",
    rhythm:
      "Skincare results need consistency, and consistency needs reminders. ChairBack learns each client's visit rhythm and brings them back monthly: the difference between a client and a regular.",
    points: [
      {
        title: "Reward the ritual",
        body: "Facials, peels, massages: every completed visit earns toward rewards you design, like a free add-on or $25 off a package.",
      },
      {
        title: "Fill quiet weekdays",
        body: "Targeted promo texts to clients who are due (not everyone) keep your weekday book from going hollow.",
      },
      {
        title: "Elegant, branded, no app",
        body: "Your logo and colors on a rewards page and a public mini-site that looks like your spa, not like software.",
      },
    ],
    rewardExample: "“5 facials = free LED add-on” or “$25 off your 6th massage”",
  },
  tattoo: {
    label: "Tattoo & piercing studios",
    industryKey: "tattoo",
    headline: ["Bring collectors back", "for the next piece."],
    sub: "Loyalty and follow-up texts for studios. Reward repeat sessions and stay top-of-mind between pieces.",
    rhythm:
      "Months can pass between sessions, and that's exactly when clients drift to whoever's on their feed. ChairBack keeps score of every session and reaches out when a client's usual gap says they're ready for the next one.",
    points: [
      {
        title: "Reward repeat sessions",
        body: "Sessions earn punches toward real money off the next piece: a reason to book the half-sleeve with you, not the shop across town.",
      },
      {
        title: "Flash-day blasts that convert",
        body: "Announce flash days and open slots to opted-in clients, with redemptions tracked so you know the blast paid.",
      },
      {
        title: "Your book, owned by you",
        body: "Every client, phone number, and session in one place you own, not scattered across DMs.",
      },
    ],
    rewardExample: "“4 sessions = $25 off” or “free touch-up after your 3rd piece”",
  },
  barbers: {
    label: "Barbershops",
    industryKey: "barber",
    headline: ["Keep your", "chair full."],
    sub: "Automatic loyalty punch cards and perfectly-timed rebooking texts for barbershops. Every cut counts itself.",
    rhythm:
      "A two-week regular who slips to five weeks is money walking out the door. ChairBack learns each client's rhythm and texts them right when the fade grows out.",
    points: [
      {
        title: "Punches that count themselves",
        body: "Every completed cut adds a punch automatically. No-shows never sneak one in.",
      },
      {
        title: "At-risk radar",
        body: "See exactly which regulars are overdue today and nudge them with one tap, or let the engine do it.",
      },
      {
        title: "Your shop's own page",
        body: "A branded rewards card and public mini-site with your work, hours, and live specials.",
      },
    ],
    rewardExample: "“10 cuts = free cut” or “free lineup on visit 6”",
  },
};

export function generateStaticParams() {
  return Object.keys(VERTICALS).map((vertical) => ({ vertical }));
}

export function generateMetadata({
  params,
}: {
  params: { vertical: string };
}): Metadata {
  const v = VERTICALS[params.vertical];
  if (!v) return {};
  return {
    title: `${APP_NAME} for ${v.label}: loyalty punch cards & rebooking texts`,
    description: v.sub,
  };
}

export default function VerticalPage({
  params,
}: {
  params: { vertical: string };
}) {
  const v = VERTICALS[params.vertical];
  if (!v) notFound();

  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[36rem]"
        style={{
          background:
            "radial-gradient(50rem 26rem at 70% -10%, rgba(212,175,55,0.12), transparent 65%)",
        }}
      />

      <header className="sticky top-0 z-20">
        <nav className="glass mx-auto mt-4 flex w-[min(72rem,calc(100%-2rem))] items-center justify-between rounded-full px-5 py-3">
          <Link href="/" className="font-display text-base tracking-tight">
            {APP_NAME}
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-full px-4 py-2 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-gold-gradient px-4 py-2 text-sm font-semibold text-charcoal shadow-glow-sm transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow hover:brightness-105"
            >
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl px-6">
        <section className="pb-16 pt-16 text-center sm:pt-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold-soft">
            {APP_NAME} for {v.label.toLowerCase()}
          </p>
          <h1 className="mx-auto mt-6 max-w-2xl font-display text-5xl leading-[1.05] tracking-tight sm:text-6xl">
            {v.headline[0]} <span className="text-gradient-gold">{v.headline[1]}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted">
            {v.sub}
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-full bg-gold-gradient px-8 py-3.5 text-sm font-semibold text-charcoal shadow-glow transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
            >
              Start your {BILLING.trialDays}-day free trial
            </Link>
            <Link
              href="/#pricing"
              className="rounded-full border border-subtle px-7 py-3.5 text-sm font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-5 text-xs text-muted">
            Loyalty is free forever · Premium from ${BILLING.priceMonthlyUsd}/mo after a{" "}
            {BILLING.trialDays}-day trial · no card to start
          </p>
        </section>

        <section className="border-t border-subtle py-14">
          <p className="mx-auto max-w-2xl text-center text-base leading-relaxed text-offwhite/90">
            {v.rhythm}
          </p>
        </section>

        <section className="grid gap-5 pb-16 sm:grid-cols-3">
          {v.points.map((p) => (
            <div key={p.title} className="glass rounded-3xl p-6">
              <h3 className="font-display text-lg">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
            </div>
          ))}
        </section>

        <section className="rounded-3xl border border-gold/20 bg-gold/[0.06] p-8 text-center sm:p-12">
          <h2 className="font-display text-3xl tracking-tight">
            Your card, your rules.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
            Design rewards that fit how {v.label.toLowerCase()} actually work:{" "}
            {v.rewardExample}. Set it up in five minutes; pick “{v.label}” at
            signup and the defaults are already right.
          </p>
          <Link
            href="/signup"
            className="mt-7 inline-block rounded-full bg-gold-gradient px-9 py-3.5 text-sm font-semibold text-charcoal shadow-glow transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
          >
            Get started free
          </Link>
        </section>

        <footer className="flex flex-wrap items-center justify-center gap-5 py-10 text-xs text-muted">
          <Link href="/" className="transition-colors duration-150 ease-out hover:text-offwhite">
            {APP_NAME} home
          </Link>
          <Link href="/terms" className="transition-colors duration-150 ease-out hover:text-offwhite">
            Terms
          </Link>
          <Link href="/privacy" className="transition-colors duration-150 ease-out hover:text-offwhite">
            Privacy
          </Link>
          <Link href="/sms" className="transition-colors duration-150 ease-out hover:text-offwhite">
            SMS Policy
          </Link>
        </footer>
      </main>
    </div>
  );
}
