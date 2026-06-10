import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { LinkButton } from "@/components/ui/Button";

export default function LandingPage() {
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      {/* Nav */}
      <header className="sticky top-0 z-20">
        <nav className="glass mx-auto mt-4 flex w-[min(72rem,calc(100%-2rem))] items-center justify-between rounded-full px-5 py-3">
          <Link href="/" className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-gold" />
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

      <main className="mx-auto w-full max-w-6xl px-6">
        {/* Hero */}
        <section className="grid items-center gap-14 pb-24 pt-16 sm:pt-24 lg:grid-cols-2">
          <div className="text-center lg:text-left">
            <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              Built on top of your Acuity scheduling
            </p>
            <h1 className="mt-6 font-display text-5xl leading-[1.05] tracking-tight sm:text-7xl">
              Keep your <span className="text-gradient-gold">chair full.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted lg:mx-0">
              Automatic loyalty punch cards and perfectly-timed rebooking texts
              for barbershops. No paper cards, no manual follow-up — every cut
              counts itself.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
              <LinkButton href="/signup" className="px-8 py-3.5">
                Start free
              </LinkButton>
              <Link
                href="/login"
                className="rounded-full border border-subtle px-7 py-3.5 text-sm font-medium text-offwhite transition-colors hover:border-subtle-strong hover:bg-charcoal-700"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-6 text-xs text-muted">
              Set up in minutes · Works with your existing booking link
            </p>
          </div>

          {/* Floating punch-card demo */}
          <div className="relative mx-auto w-full max-w-sm">
            <div
              className="absolute -inset-10 -z-10 rounded-full bg-gold/10 blur-3xl"
              aria-hidden
            />
            <div className="ring-conic glass animate-float rounded-3xl p-7">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.2em] text-muted">
                  Drick&apos;s Barbershop
                </p>
                <Scissors className="h-4 w-4 text-gold/70" />
              </div>
              <div className="mt-4 font-display text-7xl leading-none text-gradient-gold">
                7<span className="align-top text-3xl text-muted">/10</span>
              </div>
              <p className="mt-2 text-sm text-muted">
                3 more cuts to your <span className="text-gold-soft">Free Cut</span>
              </p>
              <div className="mt-6 grid grid-cols-5 gap-2.5">
                {Array.from({ length: 10 }, (_, i) => (
                  <div
                    key={i}
                    className={
                      i < 7
                        ? "aspect-square rounded-full bg-gold-gradient shadow-glow-sm"
                        : "aspect-square rounded-full border border-subtle bg-charcoal-700"
                    }
                  />
                ))}
              </div>
              <div className="hairline mt-6" />
              <div className="mt-4 flex items-center justify-between text-xs text-muted">
                <span>Last visit · May 28</span>
                <span className="rounded-full border border-gold/40 px-2.5 py-1 text-gold">
                  Book again
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Feature cards */}
        <section className="pb-24">
          <h2 className="text-center font-display text-3xl tracking-tight sm:text-4xl">
            Loyalty that runs itself
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted">
            Connect once. Every appointment becomes a punch, every no-show
            becomes a text, every regular stays a regular.
          </p>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="glass group rounded-3xl p-7 transition-all duration-300 hover:-translate-y-1 hover:border-gold/25 hover:shadow-glow-sm"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-gold/25 bg-gold/10 text-gold transition-transform duration-300 group-hover:scale-110">
                  {f.icon}
                </div>
                <h3 className="mt-5 font-display text-xl">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="pb-24">
          <div className="glass rounded-4xl px-7 py-12 sm:px-12">
            <h2 className="text-center font-display text-3xl tracking-tight">
              Three steps, then it&apos;s automatic
            </h2>
            <div className="mt-10 grid gap-10 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <div key={s.title} className="relative text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gold-gradient font-display text-lg text-charcoal shadow-glow-sm">
                    {i + 1}
                  </div>
                  <h3 className="mt-4 font-display text-lg">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="pb-28 text-center">
          <h2 className="font-display text-4xl tracking-tight sm:text-5xl">
            Your regulars, <span className="text-gradient-gold">on autopilot.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted">
            Stop losing clients who just forgot to rebook. {APP_NAME} brings
            them back to your chair.
          </p>
          <div className="mt-8">
            <LinkButton href="/signup" className="animate-pulse-glow px-10 py-4 text-base">
              Get started free
            </LinkButton>
          </div>
        </section>
      </main>

      <footer className="border-t border-subtle py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-muted sm:flex-row">
          <span className="flex items-center gap-2">
            <Scissors className="h-3.5 w-3.5 text-gold/60" />
            {APP_NAME} — built for barbers.
          </span>
          <div className="flex gap-5">
            <Link href="/login" className="hover:text-offwhite">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-offwhite">
              Create account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    title: "Punches that count themselves",
    body: "Every completed appointment in Acuity automatically adds a punch. Clients check their card from a private link — no app, no login, no paper.",
    icon: <CheckBadge />,
  },
  {
    title: "Texts at the perfect moment",
    body: "ChairBack learns each client's rhythm and nudges them right when they're due for a cut — before they drift to another shop.",
    icon: <ChatBubble />,
  },
  {
    title: "See the money come back",
    body: "A live dashboard shows who's at risk, who rebooked because of a nudge, and the revenue you recovered this month.",
    icon: <ChartUp />,
  },
] as const;

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

/* --- inline icons (no extra deps) --- */

function Scissors({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
    </svg>
  );
}

function CheckBadge() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ChatBubble() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

function ChartUp() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 5-6" />
    </svg>
  );
}
