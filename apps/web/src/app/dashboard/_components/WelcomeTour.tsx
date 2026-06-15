"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { APP_NAME } from "@chairback/config/constants";
import { markWelcomeSeenAction } from "../actions";

/**
 * First-run welcome carousel. Auto-opens ONCE for a brand-new barber (driven by
 * the persisted `welcomeSeen` flag on the user), walking them through what
 * ChairBack gives them and how each piece works. Short slides, real features,
 * links straight to where they'd act.
 *
 * Replay: any "cb:open-welcome-tour" DOM event reopens it (the account card
 * dispatches one). A replay never re-stamps the seen flag - that timestamp is
 * the first sighting only, so the tour still won't auto-open again.
 */

export const OPEN_TOUR_EVENT = "cb:open-welcome-tour";

interface Slide {
  icon: string;
  title: string;
  body: string;
  /** Optional deep link into the feature this slide describes. */
  href?: string;
  cta?: string;
}

const SLIDES: Slide[] = [
  {
    icon: "✂️",
    title: `Welcome to ${APP_NAME}`,
    body:
      "This is your loyalty and rebooking command center. In the next few screens, here's exactly what you're getting and how to use it. It takes about a minute.",
  },
  {
    icon: "👥",
    title: "Clients & punch cards",
    body:
      "Every client you serve lives on the Clients page with their own digital punch card. Each completed visit earns a punch automatically once Acuity is connected, or add a walk-in by hand. Tap a client to see their history, notes, and balance.",
    href: "/dashboard/clients",
    cta: "Open Clients",
  },
  {
    icon: "🎁",
    title: "Rewards your clients chase",
    body:
      "Build your reward menu: say 10 punches for a free cut. Clients see their progress on a card you can share with them. Set it up once in the Rewards tab and it runs itself; redeem rewards in one tap when they cash in.",
    href: "/dashboard/rewards",
    cta: "Build rewards",
  },
  {
    icon: "💬",
    title: "Win-back nudges (on autopilot)",
    body:
      "When a regular goes quiet, ChairBack can text them a friendly nudge to rebook, within the limits you set. You stay in control: review who's at risk on the Overview, and only consented clients are ever messaged.",
    href: "/dashboard/nudges",
    cta: "See nudges",
  },
  {
    icon: "🌐",
    title: "Your page & new requests",
    body:
      "You get a shareable mini-site (your Page) with your rewards, hours, and booking link. Turn on requests and clients with no online booking can ask for an appointment. Leads land in your dashboard and text you instantly.",
    href: "/dashboard/site",
    cta: "Set up your page",
  },
  {
    icon: "🔗",
    title: "One last thing: connect Acuity",
    body:
      "Linking your Acuity calendar imports your client history and auto-syncs new visits, so punches and rebooking just happen. You can connect it now or anytime from your Overview. That's the tour. You're ready to roll.",
    href: "/onboarding/connect",
    cta: "Connect Acuity",
  },
];

export function WelcomeTour({ welcomeSeen }: { welcomeSeen: boolean }) {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  // Track whether THIS mount auto-opened, so we only stamp the seen flag for the
  // genuine first run (not a manual replay).
  const [autoRun, setAutoRun] = useState(false);

  // Auto-open once on the first dashboard visit.
  useEffect(() => {
    if (!welcomeSeen) {
      setOpen(true);
      setAutoRun(true);
    }
  }, [welcomeSeen]);

  // Replay trigger from elsewhere on the page (account card button).
  useEffect(() => {
    function onOpen() {
      setI(0);
      setAutoRun(false);
      setOpen(true);
    }
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Stamp "seen" only for the auto-run first sighting; fire-and-forget.
    if (autoRun) {
      setAutoRun(false);
      void markWelcomeSeenAction();
    }
  }, [autoRun]);

  // Close on Escape, like a standard modal.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const isLast = i === SLIDES.length - 1;
  // SLIDES is a non-empty literal and `i` is always clamped to its bounds, so
  // this is never undefined; the fallback satisfies noUncheckedIndexedAccess.
  const slide = SLIDES[i] ?? SLIDES[0]!;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-label="Welcome tour"
        >
          {/* Backdrop - click to close (counts as seen) */}
          <div
            className="absolute inset-0 bg-charcoal/80 backdrop-blur-sm"
            onClick={close}
          />

          <motion.div
            className="glass relative w-full max-w-md rounded-2xl p-7"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 140, damping: 18 }}
          >
            {/* Progress dots */}
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {SLIDES.map((_, n) => (
                  <span
                    key={n}
                    className={`h-1.5 rounded-full transition-all ${
                      n === i ? "w-5 bg-gold" : "w-1.5 bg-charcoal-700"
                    }`}
                  />
                ))}
              </div>
              <button
                onClick={close}
                className="text-xs text-muted transition-colors hover:text-offwhite"
              >
                Skip
              </button>
            </div>

            {/* Slide content (crossfades on change) */}
            <AnimatePresence mode="wait">
              <motion.div
                key={i}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.2 }}
              >
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gold/10 text-2xl"
                  aria-hidden
                >
                  {slide.icon}
                </div>
                <h2 className="font-display text-2xl tracking-tight text-offwhite">
                  {slide.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {slide.body}
                </p>
                {slide.href && (
                  <a
                    href={slide.href}
                    onClick={close}
                    className="mt-3 inline-block text-xs font-medium text-gold hover:underline"
                  >
                    {slide.cta} →
                  </a>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Nav */}
            <div className="mt-7 flex items-center justify-between gap-3">
              <button
                onClick={() => setI((n) => Math.max(0, n - 1))}
                disabled={i === 0}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:cursor-not-allowed disabled:opacity-0"
              >
                Back
              </button>
              <span className="text-[11px] text-muted/70">
                {i + 1} of {SLIDES.length}
              </span>
              {isLast ? (
                <button
                  onClick={close}
                  className="rounded-full bg-gold-gradient px-5 py-2 text-sm font-semibold text-charcoal shadow-glow transition-all hover:shadow-glow-lg hover:brightness-105"
                >
                  Get started
                </button>
              ) : (
                <button
                  onClick={() => setI((n) => Math.min(SLIDES.length - 1, n + 1))}
                  className="rounded-full bg-gold-gradient px-5 py-2 text-sm font-semibold text-charcoal shadow-glow transition-all hover:shadow-glow-lg hover:brightness-105"
                >
                  Next
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
