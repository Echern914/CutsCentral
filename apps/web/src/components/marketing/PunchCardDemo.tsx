"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";

const START = 6;
const THRESHOLD = 10;

/**
 * The hero's living punch card. Once scrolled into view it stamps punches in
 * one by one, celebrates the unlocked reward, then resets and loops. Static
 * 7/10 under prefers-reduced-motion.
 */
export function PunchCardDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [punches, setPunches] = useState(START);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => {
      setPunches((p) => (p >= THRESHOLD ? START : p + 1));
    }, 1400);
    return () => clearInterval(id);
  }, [inView, reduce]);

  const count = reduce ? 7 : punches;
  const unlocked = count >= THRESHOLD;
  const remaining = THRESHOLD - count;

  return (
    <div
      ref={ref}
      className={`ring-conic glass rounded-3xl p-7 transition-shadow duration-700 ${
        unlocked ? "shadow-glow" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Drick&apos;s Barbershop
        </p>
        <ScissorsMark className="h-4 w-4 text-gold/70" />
      </div>

      <div className="mt-4 flex items-end justify-between">
        <div className="font-display text-7xl leading-none text-gradient-gold">
          {count}
          <span className="align-top text-3xl text-muted">/{THRESHOLD}</span>
        </div>
      </div>

      <div className="mt-2 h-5 text-sm">
        <AnimatePresence mode="wait" initial={false}>
          {unlocked ? (
            <motion.p
              key="unlocked"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="font-medium text-gold-soft"
            >
              Free Cut unlocked — show this at the chair
            </motion.p>
          ) : (
            <motion.p
              key={`left-${remaining}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="text-muted"
            >
              {remaining} more {remaining === 1 ? "cut" : "cuts"} to your{" "}
              <span className="text-gold-soft">Free Cut</span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-6 grid grid-cols-5 gap-2.5">
        {Array.from({ length: THRESHOLD }, (_, i) => (
          <motion.div
            key={i}
            animate={
              i < count
                ? { scale: [1, 1.25, 1], opacity: 1 }
                : { scale: 1, opacity: 1 }
            }
            transition={{ duration: 0.35, ease: "easeOut" }}
            className={
              i < count
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
  );
}

export function ScissorsMark({ className }: { className?: string }) {
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
