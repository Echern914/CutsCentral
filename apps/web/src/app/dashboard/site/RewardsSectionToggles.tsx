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
 * `value` is the list of VISIBLE keys. Pure visibility: toggling appends or
 * removes a key and NOTHING reorders (the rewards page renders sections in a
 * fixed order regardless of this list's order, so order here is irrelevant).
 * The earlier version re-canonicalized the order on every "on" click, which made
 * the switches feel like they jumped/flipped the wrong row - that's gone now.
 *
 * Last-one guard: the API reads an empty list as "show all", so we can't let the
 * list reach []. We block hiding the final visible section AND show a hint on
 * that row so the disabled switch reads as intentional, not broken.
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
      if (visible.size <= 1) return; // keep at least one (empty = "show all")
      onChange(value.filter((k) => k !== key)); // remove, no reorder
    } else {
      onChange([...value, key]); // append, no reorder
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
              <p className="truncate text-[11px] text-muted">
                {isLastOn ? "Always on — keep at least one section" : section.hint}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isVisible}
              aria-label={`${isVisible ? "Hide" : "Show"} ${section.label}`}
              onClick={() => toggle(key)}
              disabled={isLastOn}
              title={isLastOn ? "Keep at least one section" : undefined}
              style={{ width: 36, height: 20 }}
              className={cn(
                // Explicit px box + box-border so a stray border/box-sizing can't
                // widen the track (which pushed the knob past the right edge). The
                // knob is absolutely placed by left/right insets - no translate or
                // baseline math, so it can't detach or overflow in any context.
                "relative box-border shrink-0 rounded-full transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60",
                isVisible ? "bg-emerald-soft/70" : "bg-charcoal-600",
              )}
            >
              <span
                aria-hidden
                style={{ width: 16, height: 16, top: 2, [isVisible ? "right" : "left"]: 2 }}
                className="absolute rounded-full bg-white shadow-sm transition-all duration-150 ease-out"
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
