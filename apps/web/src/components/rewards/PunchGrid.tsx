"use client";

import { motion } from "framer-motion";
import { punchFill, staggerContainer } from "@/components/motion/variants";
import type { RewardsTheme } from "@/app/r/[magicToken]/theme";

/**
 * Animated punch card grid. `threshold` slots; the first `filled` are the shop's
 * accent with a scale-in pop, the rest are empty outlines in the theme's border
 * color. Fixed dimensions so there's no layout shift on load.
 */
export function PunchGrid({
  filled,
  threshold,
  theme,
}: {
  filled: number;
  threshold: number;
  theme: RewardsTheme;
}) {
  const slots = Array.from({ length: threshold }, (_, i) => i < filled);
  // Choose columns that keep the grid balanced for common thresholds.
  const cols = threshold % 5 === 0 ? 5 : threshold % 4 === 0 ? 4 : 5;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      // Filled vs empty slots differ only by color — expose the progress as
      // one readable summary and hide the decorative grid from AT (WCAG 1.4.1).
      role="img"
      aria-label={`${filled} of ${threshold} punches earned`}
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {slots.map((isFilled, i) => (
        <motion.div
          key={i}
          aria-hidden="true"
          variants={punchFill}
          initial="empty"
          animate={isFilled ? "filled" : "empty"}
          className="flex aspect-square items-center justify-center rounded-full border"
          style={
            isFilled
              ? {
                  backgroundColor: theme.accent,
                  borderColor: theme.accent,
                  color: theme.onAccent,
                  boxShadow: `0 8px 24px -12px ${theme.accent}`,
                }
              : {
                  backgroundColor: theme.bg,
                  borderColor: theme.border,
                  color: theme.muted,
                }
          }
        >
          <span className="text-lg" style={{ fontFamily: "var(--page-display)" }}>
            {i + 1}
          </span>
        </motion.div>
      ))}
    </motion.div>
  );
}
