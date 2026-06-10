"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";

/** Animated number count-up. Falls back to the final value under reduced motion. */
export function CountUp({
  value,
  duration = 1.0,
  className,
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  // Start at 0 (matches SSR HTML exactly); the first effect animates 0 -> value.
  // Seeding the ref with `value` made the first animation a value -> value no-op.
  const [display, setDisplay] = useState(0);
  const node = useRef(0);

  useEffect(() => {
    if (reduce) {
      node.current = value;
      setDisplay(value);
      return;
    }
    const from = node.current;
    node.current = value;
    const controls = animate(from, value, {
      duration,
      ease: "easeOut",
      onUpdate(v) {
        setDisplay(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, duration, reduce]);

  return <span className={className}>{display}</span>;
}
