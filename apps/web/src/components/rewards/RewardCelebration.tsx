"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * A single tasteful celebratory moment when a reward is unlocked: a radial gold
 * shimmer that fades once (<1.5s). Respects reduced motion (renders a static
 * banner instead).
 */
export function RewardCelebration({
  count,
  label,
}: {
  /** How many rewards are claimable; `label` names the first when count is 1. */
  count: number;
  label: string;
}) {
  const reduce = useReducedMotion();

  return (
    <div className="relative overflow-hidden rounded-2xl border border-gold/40 bg-charcoal-800 p-5 text-center">
      {!reduce && (
        <motion.div
          aria-hidden
          initial={{ opacity: 0.7, scale: 0.2 }}
          animate={{ opacity: 0, scale: 2.2 }}
          transition={{ duration: 1.4, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 m-auto h-40 w-40 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(212,175,55,0.5) 0%, rgba(212,175,55,0) 70%)",
          }}
        />
      )}
      <p className="font-display text-xl text-gold">
        {count === 1 ? "Reward unlocked!" : "Rewards unlocked!"}
      </p>
      <p className="mt-1 text-sm text-offwhite">
        {count === 1 ? (
          <>
            You&apos;ve earned a <span className="font-semibold">{label}</span>.
          </>
        ) : (
          <>
            You&apos;ve got <span className="font-semibold">{count} rewards</span> ready
            to claim.
          </>
        )}{" "}
        Show this to your barber.
      </p>
    </div>
  );
}
