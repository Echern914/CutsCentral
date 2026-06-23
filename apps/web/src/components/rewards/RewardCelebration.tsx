"use client";

import { motion, useReducedMotion } from "framer-motion";
import { surfaceStyle, type RewardsTheme } from "@/app/r/[magicToken]/theme";

/**
 * A single tasteful celebratory moment when a reward is unlocked: a radial
 * shimmer in the shop's accent that fades once (<1.5s). Respects reduced motion
 * (renders a static banner instead). Theme-driven to match the barber's identity.
 */
export function RewardCelebration({
  count,
  label,
  theme,
}: {
  /** How many rewards are claimable; `label` names the first when count is 1. */
  count: number;
  label: string;
  theme: RewardsTheme;
}) {
  const reduce = useReducedMotion();

  return (
    <div
      className="relative overflow-hidden p-5 text-center"
      style={{ ...surfaceStyle(theme), borderColor: `${theme.accent}66` }}
    >
      {!reduce && (
        <motion.div
          aria-hidden
          initial={{ opacity: 0.7, scale: 0.2 }}
          animate={{ opacity: 0, scale: 2.2 }}
          transition={{ duration: 1.4, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 m-auto h-40 w-40 rounded-full"
          style={{
            background: `radial-gradient(circle, ${theme.accent}80 0%, ${theme.accent}00 70%)`,
          }}
        />
      )}
      <p className="text-xl" style={{ color: theme.accent, fontFamily: "var(--page-display)" }}>
        {count === 1 ? "Reward unlocked!" : "Rewards unlocked!"}
      </p>
      <p className="mt-1 text-sm">
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
        Show this at your next visit.
      </p>
    </div>
  );
}
