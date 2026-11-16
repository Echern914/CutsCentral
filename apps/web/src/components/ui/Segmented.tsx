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
  size = "compact",
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  className?: string;
  /**
   * "compact" is the default and renders byte-identically to what every
   * existing call site already had. "comfortable" grows each segment to a 44px
   * touch target on coarse pointers — required inside dialogs and other
   * thumb-first surfaces, where a 26px pill is not reliably hittable.
   */
  size?: "compact" | "comfortable";
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        // Studio: a field-coloured track; the chosen segment is a raised
        // surface. Square-ish corners, so a track that WRAPS to two rows at
        // 320px still reads as one control rather than a lozenge.
        "flex items-center gap-1 rounded-xl bg-offwhite/[0.06] p-0.5",
        size === "comfortable" ? "w-full flex-wrap sm:w-fit sm:flex-nowrap" : "w-fit",
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
            "rounded-lg text-xs font-medium transition-colors duration-150 ease-out",
            size === "comfortable"
              ? // Even thirds while wrapped, so two rows read as a grid rather
                // than as a full row plus a leftover.
                "flex h-11 min-w-[2.75rem] flex-1 basis-[calc(33.333%-0.5rem)] items-center justify-center px-3 sm:h-8 sm:min-w-0 sm:flex-none sm:basis-auto"
              : "px-3 py-1",
            value === o.key
              ? "bg-charcoal-800 text-offwhite shadow-ambient ring-1 ring-offwhite/[0.08]"
              : "text-muted hover:text-offwhite",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
