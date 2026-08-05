"use client";

import { cn } from "@/lib/cn";

/**
 * The one segmented pill control. Insights alone had grown three hand-rolled
 * variants of this (period pills, count/revenue toggle, chair-time views) with
 * three slightly different paddings and active states; every new toggle made
 * the page a little less of one system. One component, one look.
 */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "flex w-fit items-center gap-1 rounded-full border border-subtle p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={cn(
            "rounded-full px-3 py-1 text-xs transition-colors duration-150 ease-out",
            value === o.key ? "bg-gold/15 text-gold" : "text-muted hover:text-offwhite",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
