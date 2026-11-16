"use client";

import { motion } from "framer-motion";
import { pressable } from "@/components/motion/variants";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost";

/**
 * The Studio button: ink primary (cream on the dark theme), outlined
 * secondary. 44px tall, 10px corners. Gold is never a button.
 */
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
      ? "bg-primary text-on-primary hover:bg-primary/90"
      : "bg-charcoal-800 text-offwhite border border-subtle-strong hover:bg-charcoal-700";
  return (
    <motion.button
      {...pressable}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none",
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
        "inline-flex min-h-[44px] items-center justify-center rounded-xl px-6 py-3 text-sm font-semibold",
        "bg-primary text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90",
        className,
      )}
    >
      {children}
    </a>
  );
}
