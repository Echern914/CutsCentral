"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { APP_NAME } from "@chairback/config/constants";
import { markWelcomeSeenAction } from "../dashboard/actions";

/**
 * Full-screen, multi-section guided tour shown to a brand-new barber on their
 * first dashboard visit (the /welcome route redirects here-bound users in). It
 * walks the whole product one screen at a time - what each page is, what they'd
 * do there, and a deep link straight to it - then hands them to the dashboard.
 *
 * The persisted `welcomeSeen` flag is stamped on finish/skip so it never
 * auto-runs again; the account card can replay it via /welcome?replay=1, and a
 * replay (replay=true) deliberately does NOT re-stamp anything.
 */

type IconProps = { className?: string };

/**
 * Line icons in the codebase's house style (Lucide-like: 24x24, no fill,
 * currentColor stroke, rounded caps). One per section so each screen has its
 * own mark - no emoji.
 */
const Icons = {
  scissors: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
    </svg>
  ),
  chart: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 5-6" />
    </svg>
  ),
  users: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  gift: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
      <path d="M12 8S10.5 4 8 4a2.5 2.5 0 0 0 0 5h4Zm0 0s1.5-4 4-4a2.5 2.5 0 0 1 0 5h-4Z" />
    </svg>
  ),
  message: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-9 8.34 9.5 9.5 0 0 1-4-.9L3 20l1.06-3a8.34 8.34 0 0 1-.9-4A8.38 8.38 0 0 1 11.5 3 8.5 8.5 0 0 1 21 11.5Z" />
    </svg>
  ),
  globe: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </svg>
  ),
  card: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  ),
  link: ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
} as const;

interface Section {
  /** Line icon (house style) shown in the gradient art block. */
  Icon: (props: IconProps) => JSX.Element;
  /** Tiny eyebrow above the headline (the page/feature name). */
  eyebrow: string;
  title: string;
  body: string;
  /** The concrete "here's what you do" line under the body. */
  doThis: string;
  /** Optional deep link into the feature this section describes. */
  href?: string;
  cta?: string;
  /** Tailwind gradient classes for the art block, so each screen feels distinct. */
  art: string;
}

const SECTIONS: Section[] = [
  {
    Icon: Icons.scissors,
    eyebrow: "Welcome",
    title: `This is ${APP_NAME}`,
    body: `${APP_NAME} keeps your chairs full: it remembers every client, runs your loyalty punch cards, and texts the regulars who've gone quiet so they rebook. The next minute walks you through the whole thing - skip anytime.`,
    doThis: "Tap Next to see your command center.",
    art: "from-gold/25 via-gold/10 to-transparent",
  },
  {
    Icon: Icons.chart,
    eyebrow: "Overview",
    title: "Your command center",
    body: "The dashboard is home base. At a glance you see this month's visits and rewards, who's at risk of slipping away, a live activity feed, and your busiest regulars on the leaderboard.",
    doThis: "You're already here - this is the page you'll open every morning.",
    href: "/dashboard",
    cta: "Go to Overview",
    art: "from-sky-400/20 via-sky-400/5 to-transparent",
  },
  {
    Icon: Icons.users,
    eyebrow: "Clients",
    title: "Every client, on a punch card",
    body: "Each client gets a digital punch card. Once Acuity is connected, finished visits earn a punch automatically; walk-ins you add by hand. Tap any client for their full history, notes, and balance.",
    doThis: "Open the Clients page to add a walk-in or look someone up.",
    href: "/dashboard/clients",
    cta: "Open Clients",
    art: "from-violet-400/20 via-violet-400/5 to-transparent",
  },
  {
    Icon: Icons.gift,
    eyebrow: "Rewards",
    title: "Rewards they chase",
    body: "Build your reward menu - say 10 punches for a free cut. Clients watch their progress on a card you can share. Set it once and it runs itself; redeem in one tap when they cash in.",
    doThis: "Head to Rewards to set up your first one.",
    href: "/dashboard/rewards",
    cta: "Build rewards",
    art: "from-pink-400/20 via-pink-400/5 to-transparent",
  },
  {
    Icon: Icons.message,
    eyebrow: "Nudges",
    title: "Win-backs on autopilot",
    body: `When a regular goes quiet, ${APP_NAME} can text a friendly nudge to rebook - within the limits you set, and only to clients who've consented. You review who's at risk and stay fully in control of what goes out.`,
    doThis: "See who's drifting and how nudges work.",
    href: "/dashboard/nudges",
    cta: "See nudges",
    art: "from-emerald-400/20 via-emerald-400/5 to-transparent",
  },
  {
    Icon: Icons.globe,
    eyebrow: "Your page",
    title: "A page clients can share",
    body: "You get a shareable mini-site with your rewards, hours, and booking link. Turn on requests and clients without online booking can ask for an appointment - leads land in your dashboard and text you instantly.",
    doThis: "Set up your public page and booking link.",
    href: "/dashboard/site",
    cta: "Set up your page",
    art: "from-amber-400/20 via-amber-400/5 to-transparent",
  },
  {
    Icon: Icons.card,
    eyebrow: "Payments",
    title: "Get paid up front",
    body: "Let clients pay ahead with a card or Apple Pay when they book. You connect your own Stripe account - money settles straight to you, never through us. Set a cancellation window and fee, and refunds happen automatically by your policy.",
    doThis: "Connect Stripe and turn on pay-ahead when you're ready.",
    href: "/dashboard/payments",
    cta: "Set up payments",
    art: "from-teal-400/20 via-teal-400/5 to-transparent",
  },
  {
    Icon: Icons.link,
    eyebrow: "Go live",
    title: "Connect Acuity & you're set",
    body: "Linking your Acuity calendar imports your client history and auto-syncs new visits, so punches and rebooking just happen. Connect it now or anytime from your Overview - that's the whole tour.",
    doThis: "Connect Acuity to go live, or jump into your dashboard.",
    href: "/onboarding/connect",
    cta: "Connect Acuity",
    art: "from-gold/25 via-gold/10 to-transparent",
  },
];

export function WelcomeFlow({
  connected,
  replay,
}: {
  /** Acuity already linked - skip the "connect" pitch on the last screen. */
  connected: boolean;
  /** Replaying from the account card: never re-stamp the seen flag. */
  replay: boolean;
}) {
  const router = useRouter();
  const [i, setI] = useState(0);
  // Guard so a double-fire (finish + unmount, fast clicks) only stamps once.
  const [leaving, setLeaving] = useState(false);

  const total = SECTIONS.length;
  const isLast = i === total - 1;
  // SECTIONS is a non-empty literal and `i` is clamped to its bounds, so this is
  // never undefined; the fallback satisfies noUncheckedIndexedAccess.
  const section = SECTIONS[i] ?? SECTIONS[0]!;

  // Leave the tour for `dest`, stamping "seen" once (unless this is a replay).
  const finish = useCallback(
    (dest: string) => {
      if (leaving) return;
      setLeaving(true);
      if (!replay) void markWelcomeSeenAction();
      router.push(dest);
    },
    [leaving, replay, router],
  );

  const next = useCallback(() => {
    setI((n) => Math.min(total - 1, n + 1));
  }, [total]);

  const back = useCallback(() => {
    setI((n) => Math.max(0, n - 1));
  }, []);

  // Arrow keys to move, Esc to skip - standard for a full-screen flow.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") finish("/dashboard");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, finish]);

  return (
    <main className="relative flex min-h-screen flex-col bg-charcoal text-offwhite">
      {/* Top bar: brand + skip */}
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5">
        <span className="font-display text-lg tracking-tight">{APP_NAME}</span>
        <button
          onClick={() => finish("/dashboard")}
          className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          Skip tour
        </button>
      </div>

      {/* Progress rail */}
      <div className="mx-auto flex w-full max-w-3xl items-center gap-1.5 px-5">
        {SECTIONS.map((_, n) => (
          <span
            key={n}
            className={`h-1 flex-1 rounded-full transition-all duration-200 ease-out ${
              n <= i ? "bg-gold" : "bg-charcoal-700"
            }`}
          />
        ))}
      </div>

      {/* Section content */}
      <div className="mx-auto flex w-full max-w-3xl flex-1 items-center px-5 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={i}
            className="grid w-full gap-8 sm:grid-cols-2 sm:items-center"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {/* Art block */}
            <div
              className={`flex aspect-square w-full items-center justify-center rounded-3xl border border-subtle bg-gradient-to-br ${section.art} shadow-glow`}
              aria-hidden
            >
              <section.Icon className="h-20 w-20 text-gold sm:h-24 sm:w-24" />
            </div>

            {/* Copy */}
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-gold">
                {section.eyebrow}
              </p>
              <h1 className="mt-2 font-display text-3xl tracking-tight text-offwhite sm:text-4xl">
                {section.title}
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
                {section.body}
              </p>
              <p className="mt-4 text-sm font-medium text-offwhite">
                {section.doThis}
              </p>
              {section.href && (
                <a
                  href={section.href}
                  onClick={() => {
                    if (!replay) void markWelcomeSeenAction();
                  }}
                  className="mt-3 inline-block text-sm font-medium text-gold hover:underline"
                >
                  {section.cta} →
                </a>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Nav footer */}
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-6">
        <button
          onClick={back}
          disabled={i === 0}
          className="rounded-full border border-subtle px-5 py-2.5 text-sm text-muted transition-all duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite disabled:cursor-not-allowed disabled:opacity-0"
        >
          Back
        </button>
        <span className="text-xs text-muted/70">
          {i + 1} of {total}
        </span>
        {isLast ? (
          <button
            onClick={() =>
              finish(connected ? "/dashboard" : "/onboarding/connect")
            }
            className="rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
          >
            {connected ? "Go to dashboard" : "Connect Acuity"}
          </button>
        ) : (
          <button
            onClick={next}
            className="rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105"
          >
            Next
          </button>
        )}
      </div>
    </main>
  );
}
