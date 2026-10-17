"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { PublicAward } from "@chairback/config/providerAward";

/**
 * PROVIDER OF THE MONTH, on the winner's page (Eric, 2026-10-17: "when people
 * sign on to their page, show who won and how they won or why").
 *
 * The shop page opens on it: an animated card - the title and month, who
 * won, how, and ChairBack's few words on why - over every page design, so no
 * design has to know about it. Closing it leaves a small pill at the top that
 * opens it again. Once closed it stays closed for the rest of the visit.
 *
 * The booking page passes `autoOpen={false}`: there it is only the pill, so a
 * client in the middle of booking is never interrupted.
 */
export function AwardSpotlight({
  award,
  slug,
  autoOpen = true,
}: {
  award: PublicAward | null | undefined;
  slug: string;
  autoOpen?: boolean;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const seenKey = award ? `award-seen:${slug}:${award.month}` : "";

  // Open on arrival - once per visit. Storage can be unavailable (private
  // mode); then it simply opens, which is the safe direction.
  useEffect(() => {
    if (!award || !autoOpen) return;
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(seenKey) === "1";
    } catch {
      /* no storage: show it */
    }
    if (!seen) setOpen(true);
  }, [award, autoOpen, seenKey]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!award) return null;

  function close() {
    setOpen(false);
    try {
      window.sessionStorage.setItem(seenKey, "1");
    } catch {
      /* fine */
    }
  }

  return (
    <>
      {/* The pill: always there while the award shows. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-qa="award-pill"
        className="fixed left-1/2 top-[calc(0.75rem+env(safe-area-inset-top))] z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1.5 rounded-full border border-gold/50 bg-charcoal-900/90 px-3.5 py-1.5 text-xs font-semibold text-gold shadow-lg backdrop-blur"
      >
        <TrophyIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {award.title} · {award.monthLabel}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="award"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="award-title"
              data-qa="award-card"
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-gold/40 bg-charcoal-900 px-6 pb-6 pt-8 text-center text-offwhite shadow-2xl"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 24 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 12 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
            >
              {/* The glow and the sparkles: decoration only. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-56 w-56 rounded-full bg-gold/25 blur-3xl"
              />
              {!reduce &&
                SPARKS.map((s, i) => (
                  <motion.span
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-gold"
                    style={{ left: s.x, top: s.y }}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: [0, 1, 0], scale: [0, 1.4, 0], y: [0, -18] }}
                    transition={{ duration: 1.6, delay: 0.25 + i * 0.12, repeat: Infinity, repeatDelay: 1.4 }}
                  />
                ))}

              <motion.div
                className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gold/15 text-gold ring-1 ring-gold/40"
                initial={reduce ? false : { rotate: -12, scale: 0.6 }}
                animate={reduce ? undefined : { rotate: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 12, delay: 0.15 }}
              >
                <TrophyIcon className="h-8 w-8" />
              </motion.div>

              <p className="relative mt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
                {award.monthLabel}
              </p>
              <h2 id="award-title" className="relative mt-1 font-display text-2xl tracking-tight">
                {award.title}
              </h2>
              <p className="relative mt-3 text-lg font-semibold [overflow-wrap:anywhere]">{award.winnerName}</p>
              <p className="relative mt-1 text-sm font-medium text-gold [overflow-wrap:anywhere]">{award.headline}</p>
              <p className="relative mt-3 whitespace-pre-line text-sm leading-relaxed text-offwhite/80 [overflow-wrap:anywhere]">
                {award.description}
              </p>

              {award.stats.length > 0 && (
                <ul className="relative mt-4 flex flex-col gap-1.5 text-left">
                  {award.stats.map((s) => (
                    <li
                      key={s.key}
                      className="flex items-baseline justify-between gap-3 rounded-xl border border-subtle px-3 py-2"
                    >
                      <span className="min-w-0 text-xs text-muted">{s.label}</span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-offwhite">{s.value}</span>
                    </li>
                  ))}
                </ul>
              )}

              <button
                ref={closeRef}
                type="button"
                onClick={close}
                className="relative mt-5 inline-flex h-11 w-full items-center justify-center rounded-full bg-gold text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
              >
                See their page
              </button>
              <p className="relative mt-3 text-[11px] text-muted">Chosen by ChairBack</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const SPARKS = [
  { x: "14%", y: "18%" },
  { x: "82%", y: "14%" },
  { x: "24%", y: "34%" },
  { x: "74%", y: "30%" },
  { x: "50%", y: "8%" },
  { x: "88%", y: "40%" },
];

function TrophyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
    </svg>
  );
}
