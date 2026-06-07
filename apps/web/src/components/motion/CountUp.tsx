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
  const [display, setDisplay] = useState(reduce ? value : 0);
  const node = useRef(value);

  useEffect(() => {
    if (reduce) {
      setDisplay(value);
      return;
    }
    const controls = animate(node.current, value, {
      duration,
      ease: "easeOut",
      onUpdate(v) {
        setDisplay(Math.round(v));
      },
    });
    node.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);

  return <span className={className}>{display}</span>;
}
