"use client";

import { motion } from "framer-motion";
import { punchFill, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";

/**
 * Animated punch card grid. `threshold` slots; the first `filled` are gold with
 * a scale-in pop, the rest are empty outlines. Fixed dimensions so there's no
 * layout shift on load.
 */
export function PunchGrid({
  filled,
  threshold,
}: {
  filled: number;
  threshold: number;
}) {
  const slots = Array.from({ length: threshold }, (_, i) => i < filled);
  // Choose columns that keep the grid balanced for common thresholds.
  const cols = threshold % 5 === 0 ? 5 : threshold % 4 === 0 ? 4 : 5;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {slots.map((isFilled, i) => (
        <motion.div
          key={i}
          variants={punchFill}
          initial="empty"
          animate={isFilled ? "filled" : "empty"}
          className={cn(
            "aspect-square rounded-full border flex items-center justify-center",
            isFilled
              ? "bg-gold border-gold text-charcoal shadow-glow"
              : "border-subtle bg-charcoal-700 text-muted",
          )}
        >
          <span className="font-display text-lg">{i + 1}</span>
        </motion.div>
      ))}
    </motion.div>
  );
}
