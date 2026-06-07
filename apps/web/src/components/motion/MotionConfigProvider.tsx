"use client";

import { MotionConfig } from "framer-motion";

/**
 * Wraps the app so prefers-reduced-motion is honored globally. With
 * reducedMotion="user", framer-motion strips transform/layout animations for
 * users who request reduced motion.
 */
export function MotionConfigProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
