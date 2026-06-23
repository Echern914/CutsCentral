"use client";

import {
  REWARDS_SECTIONS,
  REWARDS_SECTION_KEYS,
  type RewardsSectionKey,
} from "@chairback/config/constants";
import { cn } from "@/lib/cn";

/**
 * Show/hide toggles for the optional sections of the CLIENT rewards page
 * (/r/[magicToken]). Visibility only - unlike the public page's sections these
 * are NOT reorderable (the rewards page has a deliberate emotional order). The
 * punch balance and the SMS consent card are always shown and aren't listed here.
 *
 * `value` is the list of VISIBLE keys; toggling off removes a key. We never let
 * the list become empty (an empty list means "show all" on the API), so the last
 * remaining toggle stays on - turning everything off would silently show
 * everything, which is confusing. Barbers hide individual blocks, not all.
 */
export function RewardsSectionToggles({
  value,
  onChange,
}: {
  value: RewardsSectionKey[];
  onChange: (next: RewardsSectionKey[]) => void;
}) {
  const visible = new Set(value);

  function toggle(key: RewardsSectionKey) {
    if (visible.has(key)) {
      // Don't allow hiding the very last visible section (would read as "all").
      if (visible.size <= 1) return;
      onChange(value.filter((k) => k !== key));
    } else {
      // Keep a stable canonical order regardless of click order.
      onChange(REWARDS_SECTION_KEYS.filter((k) => visible.has(k) || k === key));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {REWARDS_SECTION_KEYS.map((key) => {
        const isVisible = visible.has(key);
        const section = REWARDS_SECTIONS[key];
        const isLastOn = isVisible && visible.size <= 1;
        return (
          <div
            key={key}
            className={cn(
              "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 transition-[border-color,opacity] duration-150 ease-out",
              isVisible ? "border-subtle bg-charcoal-700" : "border-subtle/60 opacity-55",
            )}
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-offwhite">{section.label}</p>
              <p className="truncate text-[11px] text-muted">{section.hint}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isVisible}
              aria-label={`${isVisible ? "Hide" : "Show"} ${section.label}`}
              onClick={() => toggle(key)}
              disabled={isLastOn}
              title={isLastOn ? "Keep at least one section" : undefined}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60",
                isVisible ? "bg-emerald-soft/70" : "bg-charcoal-600",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150 ease-out",
                  isVisible ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
