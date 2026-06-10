import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { DashboardPreview } from "./DashboardPreview";
import { Marquee } from "./Marquee";
import { PhoneDemo } from "./PhoneDemo";
import { PunchCardDemo, ScissorsMark } from "./PunchCardDemo";
import { Reveal, Stagger, StaggerItem } from "./Reveal";
import { SectionHeading } from "./SectionHeading";
import { Tilt } from "./Tilt";

/**
 * The marketing landing page. Server component shell — every animated piece
 * is a small client component so the page still streams fast and SEO-renders.
 */
export function Landing() {
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      {/* Ambient hero glow, brighter than the global backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem]"
        style={{
          background:
            "radial-gradient(56rem 30rem at 70% -10%, rgba(212,175,55,0.13), transparent 65%), radial-gradient(40rem 24rem at 10% 0%, rgba(212,175,55,0.07), transparent 60%)",
        }}
      />

      {/* ====== Nav ====== */}
      <header className="sticky top-0 z-20">
        <nav className="glass mx-auto mt-4 flex w-[min(72rem,calc(100%-2rem))] items-center justify-between rounded-full px-5 py-3">
          <Link href="/" className="flex items-center gap-2">
            <ScissorsMark className="h-4 w-4 text-gold" />
            <span className="font-display text-base tracking-tight">{APP_NAME}</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-full px-4 py-2 text-sm text-muted transition-colors hover:text-offwhite"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-gold-gradient px-4 py-2 text-sm font-semibold text-charcoal shadow-glow-sm transition-all hover:shadow-glow hover:brightness-105"
            >
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <main>
        {/* ====== Hero ====== */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-16 px-6 pb-20 pt-16 sm:pt-24 lg:grid-cols-[1.05fr_0.95fr]">
          <Stagger className="text-center lg:text-left" gap={0.1}>
            <StaggerItem>
              <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold-soft">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                Built on top of your Acuity scheduling
              </p>
            </StaggerItem>
            <StaggerItem>
              <h1 className="mt-6 font-display text-5xl leading-[1.02] tracking-tight sm:text-7xl lg:text-[5.2rem]">
                Keep your
                <br />
                <span className="text-gradient-gold">chair full.</span>
              </h1>
            </StaggerItem>
            <StaggerItem>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted lg:mx-0">
                Automatic loyalty punch cards and perfectly-timed rebooking
                texts for barbershops. No paper cards, no manual follow-up —
                every cut counts itself.
              </p>
            </StaggerItem>
            <StaggerItem>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2 rounded-full bg-gold-gradient px-8 py-3.5 text-sm font-semibold text-charcoal shadow-glow transition-all hover:shadow-glow-lg hover:brightness-105"
                >
                  Start free
                  <ArrowIcon className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className="rounded-full border border-subtle px-7 py-3.5 text-sm font-medium text-offwhite transition-colors hover:border-subtle-strong hover:bg-charcoal-700"
                >
                  Sign in
                </Link>
              </div>
            </StaggerItem>
            <StaggerItem>
              <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted lg:justify-start">
                {["Set up in minutes", "Works with your booking link", "Free during early access"].map(
                  (t) => (
                    <li key={t} className="flex items-center gap-1.5">
                      <CheckIcon className="h-3.5 w-3.5 text-gold/70" />
                      {t}
                    </li>
                  ),
                )}
              </ul>
            </StaggerItem>
          </Stagger>

          {/* Living punch card */}
          <Reveal delay={0.15} className="relative mx-auto w-full max-w-sm">
            <div
              className="absolute -inset-12 -z-10 rounded-full bg-gold/10 blur-3xl"
              aria-hidden
            />
            <Tilt>
              <PunchCardDemo />
            </Tilt>
            <p className="mt-4 text-center text-xs text-muted">
              What your clients see — live, from a text. No app, no login.
            </p>
          </Reveal>
        </section>

        {/* ====== Capability marquee ====== */}
        <section className="border-y border-subtle bg-charcoal-900/40 py-5">
          <Marquee
            items={[
              "Automatic punch cards",
              "Smart rebooking texts",
              "Revenue attribution",
              "At-risk client radar",
              "Acuity sync",
              "Magic-link rewards page",
              "STOP handling built in",
              "Daily send caps",
              "Per-shop branding",
              "CSV exports",
              "No app for clients",
            ]}
          />
        </section>

        {/* ====== How it works ====== */}
        <section className="mx-auto w-full max-w-6xl px-6 py-24">
          <SectionHeading
            eyebrow="How it works"
            title={
              <>
                Three steps, then it&apos;s{" "}
                <span className="text-gradient-gold">automatic.</span>
              </>
            }
            sub="Connect once. Every appointment becomes a punch, every drifting client gets a text, every regular stays a regular."
          />
          <Stagger className="relative mt-14 grid gap-10 sm:grid-cols-3" gap={0.12}>
            {/* connector line */}
            <div
              aria-hidden
              className="absolute left-[16%] right-[16%] top-6 hidden h-px bg-gradient-to-r from-transparent via-gold/40 to-transparent sm:block"
            />
            {STEPS.map((s, i) => (
              <StaggerItem key={s.title} className="relative text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gold-gradient font-display text-lg text-charcoal shadow-glow-sm">
                  {i + 1}
                </div>
                <h3 className="mt-5 font-display text-xl">{s.title}</h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted">
                  {s.body}
                </p>
              </StaggerItem>
            ))}
          </Stagger>
        </section>

        {/* ====== Dashboard preview ====== */}
        <section className="mx-auto w-full max-w-6xl px-6 pb-24">
          <SectionHeading
            eyebrow="The dashboard"
            title={
              <>
                Watch the money{" "}
                <span className="text-gradient-gold">walk back in.</span>
              </>
            }
            sub="Every nudge that turns into a booking is tracked to the dollar. Know exactly who's drifting, who came back, and what it earned you."
          />
          <Reveal delay={0.1} className="relative mt-12">
            <div
              aria-hidden
              className="absolute -inset-8 -z-10 rounded-[3rem] bg-gold/[0.06] blur-3xl"
            />
            <DashboardPreview />
          </Reveal>
        </section>

        {/* ====== SMS nudges ====== */}
        <section className="border-y border-subtle bg-charcoal-900/40">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
            <Reveal className="order-2 mx-auto lg:order-1">
              <div className="relative">
                <div
                  aria-hidden
                  className="absolute -inset-10 -z-10 rounded-full bg-gold/10 blur-3xl"
                />
                <PhoneDemo className="rotate-[-3deg]" />
              </div>
            </Reveal>
            <div className="order-1 lg:order-2">
              <Reveal>
                <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold-soft">
                  <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                  Smart nudges
                </p>
                <h2 className="mt-5 font-display text-3xl tracking-tight sm:text-5xl">
                  Texts that land at the{" "}
                  <span className="text-gradient-gold">perfect moment.</span>
                </h2>
                <p className="mt-4 max-w-lg leading-relaxed text-muted">
                  {APP_NAME} learns each client&apos;s natural rhythm from their
                  visit history. When someone drifts past their usual gap, they
                  get one well-timed text — yours to word, with your booking
                  link inside.
                </p>
              </Reveal>
              <Stagger className="mt-8 flex flex-col gap-4" gap={0.1}>
                {NUDGE_POINTS.map((p) => (
                  <StaggerItem key={p.title} className="flex items-start gap-3.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-gold/25 bg-gold/10 text-gold">
                      {p.icon}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-offwhite">{p.title}</p>
                      <p className="mt-0.5 text-sm leading-relaxed text-muted">{p.body}</p>
                    </div>
                  </StaggerItem>
                ))}
              </Stagger>
            </div>
          </div>
        </section>

        {/* ====== Feature bento ====== */}
        <section className="mx-auto w-full max-w-6xl px-6 py-24">
          <SectionHeading
            eyebrow="Everything included"
            title="Loyalty that runs itself."
          />
          <Stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" gap={0.07}>
            {FEATURES.map((f, i) => (
              <StaggerItem
                key={f.title}
                className={i === 0 ? "sm:col-span-2 lg:col-span-1" : undefined}
              >
                <div className="glass group h-full rounded-3xl p-7 transition-all duration-300 hover:-translate-y-1 hover:border-gold/25 hover:shadow-glow-sm">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-gold/25 bg-gold/10 text-gold transition-transform duration-300 group-hover:scale-110">
                    {f.icon}
                  </div>
                  <h3 className="mt-5 font-display text-xl">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </section>

        {/* ====== FAQ ====== */}
        <section className="mx-auto w-full max-w-3xl px-6 pb-24">
          <SectionHeading eyebrow="FAQ" title="Quick answers." />
          <Reveal className="mt-10 flex flex-col gap-3">
            {FAQ.map((f) => (
              <details
                key={f.q}
                className="group rounded-2xl border border-subtle bg-charcoal-800/60 px-6 py-4 open:border-gold/25"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-offwhite [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="text-gold transition-transform duration-200 group-open:rotate-45">
                    <PlusIcon className="h-4 w-4" />
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
              </details>
            ))}
          </Reveal>
        </section>

        {/* ====== Final CTA ====== */}
        <section className="relative overflow-hidden border-t border-subtle">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(42rem 22rem at 50% 120%, rgba(212,175,55,0.14), transparent 70%)",
            }}
          />
          <div className="mx-auto w-full max-w-4xl px-6 py-28 text-center">
            <Reveal>
              <h2 className="font-display text-4xl tracking-tight sm:text-6xl">
                Your regulars,{" "}
                <span className="text-gradient-gold">on autopilot.</span>
              </h2>
              <p className="mx-auto mt-5 max-w-md text-muted">
                Stop losing clients who just forgot to rebook. {APP_NAME} brings
                them back to your chair.
              </p>
              <div className="mt-9">
                <Link
                  href="/signup"
                  className="inline-flex animate-pulse-glow items-center gap-2 rounded-full bg-gold-gradient px-10 py-4 text-base font-semibold text-charcoal transition-all hover:brightness-105"
                >
                  Get started free
                  <ArrowIcon className="h-4 w-4" />
                </Link>
              </div>
              <p className="mt-5 text-xs text-muted">
                No credit card. Connect Acuity and your punch cards fill
                themselves.
              </p>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ====== Footer ====== */}
      <footer className="border-t border-subtle py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 text-xs text-muted sm:flex-row">
          <span className="flex items-center gap-2">
            <ScissorsMark className="h-3.5 w-3.5 text-gold/60" />
            {APP_NAME} — built for barbers.
          </span>
          <div className="flex gap-5">
            <Link href="/login" className="transition-colors hover:text-offwhite">
              Sign in
            </Link>
            <Link href="/signup" className="transition-colors hover:text-offwhite">
              Create account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ====== content ====== */

const STEPS = [
  {
    title: "Connect Acuity",
    body: "One click links your existing scheduling. Past appointments backfill your clients' punch cards instantly.",
  },
  {
    title: "Set your reward",
    body: "10 cuts for a free cut? 8 for a free beard trim? Your card, your rules, your branding.",
  },
  {
    title: "Let it run",
    body: "Punches add up, smart texts go out, regulars come back. You just cut hair.",
  },
] as const;

const NUDGE_POINTS = [
  {
    title: "Timing learned per client",
    body: "A 2-week regular and a 6-week regular get nudged on their own schedules — not a blast on yours.",
    icon: <ClockIcon className="h-4 w-4" />,
  },
  {
    title: "Your words, your link",
    body: "Edit the message template, preview it live, and every text carries your booking link.",
    icon: <PenIcon className="h-4 w-4" />,
  },
  {
    title: "Respectful by default",
    body: "Daily send caps, one-tap opt-outs, and instant STOP handling are built in — not bolted on.",
    icon: <ShieldIcon className="h-4 w-4" />,
  },
] as const;

const FEATURES = [
  {
    title: "Punches that count themselves",
    body: "Every completed appointment automatically adds a punch. No-shows and cancellations never sneak one in.",
    icon: <BadgeIcon className="h-5 w-5" />,
  },
  {
    title: "A rewards page clients open",
    body: "Each client gets a private magic link — their card, their progress, your branding. No app, no password.",
    icon: <LinkIcon className="h-5 w-5" />,
  },
  {
    title: "See the money come back",
    body: "Bookings that follow a nudge are attributed automatically, so the dashboard shows real recovered revenue.",
    icon: <ChartIcon className="h-5 w-5" />,
  },
  {
    title: "At-risk radar",
    body: "Clients drifting past their usual gap surface on the dashboard before they're gone for good.",
    icon: <RadarIcon className="h-5 w-5" />,
  },
  {
    title: "Your whole client book",
    body: "Search, sort, bulk actions, bonus punches, notes, and CSV export — manual walk-ins included.",
    icon: <UsersIcon className="h-5 w-5" />,
  },
  {
    title: "Built-in compliance",
    body: "STOP replies opt clients out instantly, send caps stop runaway texting, and every message is logged.",
    icon: <ShieldIcon className="h-5 w-5" />,
  },
] as const;

const FAQ = [
  {
    q: "Do my clients need to download an app?",
    a: "No. Each client gets a private magic link to their punch card — it opens in the browser from a text. No account, no password, no app store.",
  },
  {
    q: "Does it work with my existing Acuity account?",
    a: "Yes. You connect Acuity once with one click. Past appointments backfill automatically, and new ones flow in as they happen.",
  },
  {
    q: "What counts as a punch?",
    a: "Completed appointments. Cancellations and no-shows never earn punches, so cards stay honest.",
  },
  {
    q: "What if a client doesn't want texts?",
    a: "They reply STOP and they're opted out instantly. You can also opt anyone out (or back in) from the dashboard.",
  },
  {
    q: "How much does it cost?",
    a: `${APP_NAME} is free during early access. You'll hear well in advance before that changes.`,
  },
] as const;

/* ====== inline icons (no extra deps) ====== */

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BadgeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 5-6" />
    </svg>
  );
}

function RadarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12 18 6" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function PenIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}
