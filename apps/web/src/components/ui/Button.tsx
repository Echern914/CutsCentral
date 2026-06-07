"use client";

import { motion } from "framer-motion";
import { pressable } from "@/components/motion/variants";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost";

/** Token-driven button with subtle press/hover micro-interactions. */
export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles =
    variant === "primary"
      ? "bg-gold text-charcoal hover:bg-gold-muted shadow-glow"
      : "bg-transparent text-offwhite border border-subtle hover:bg-charcoal-700";
  return (
    <motion.button
      {...pressable}
      className={cn(
        "rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        styles,
        className,
      )}
      {...(props as React.ComponentProps<typeof motion.button>)}
    >
      {children}
    </motion.button>
  );
}

/** Anchor styled as the primary CTA (for booking links). */
export function LinkButton({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-semibold",
        "bg-gold text-charcoal hover:bg-gold-muted shadow-glow transition-colors",
        className,
      )}
    >
      {children}
    </a>
  );
}
