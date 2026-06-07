import type { Variants } from "framer-motion";

/** Reusable framer-motion variants — subtle, tasteful, low-stiffness springs. */

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 120, damping: 18 },
  },
};

export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.05, delayChildren: 0.05 },
  },
};

export const punchFill: Variants = {
  empty: { scale: 1 },
  filled: {
    scale: [1, 1.18, 1],
    transition: { duration: 0.4, ease: "easeOut" },
  },
};

export const pressable = {
  whileTap: { scale: 0.98 },
  whileHover: { scale: 1.01 },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;
