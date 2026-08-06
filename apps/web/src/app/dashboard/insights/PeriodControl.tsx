"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { CustomRange, PeriodKey } from "./page";

/**
 * The one period control: preset pills + a "Custom…" date-to-date picker.
 * Extracted so it renders in two places — the top of the Insights page and the
 * Chair time card's period chip — while both drive the SAME page-level applied
 * state (period/range live in InsightsClient). Only the DRAFT lives here, per
 * instance: a half-typed range never fires a request, and two open pickers
 * don't mirror each other's keystrokes.
 */
export function PeriodControl({
  periods,
  period,
  periodLabel,
  windowStart,
  windowEnd,
  onSelectPeriod,
  onApplyRange,
  compact = false,
}: {
  periods: { key: PeriodKey; label: string }[];
  period: PeriodKey;
  /** The applied window's label — becomes the "Custom…" pill text when active. */
  periodLabel: string;
  /** Applied window bounds (YYYY-MM-DD) — seed the draft so the picker opens
   *  where you already are instead of empty. */
  windowStart: string;
  windowEnd: string;
  onSelectPeriod: (p: PeriodKey) => void;
  onApplyRange: (r: CustomRange) => void;
  /** Tighter pills for inline-panel placements (the Chair time card). */
  compact?: boolean;
}) {
  // The two inputs edit a DRAFT; only "Show this range" applies it.
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const pill = compact ? "px-3 py-1" : "px-3.5 py-1.5";

  return (
    <div>
      <div
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        role="group"
        aria-label="Time range"
      >
        {periods.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              setPickerOpen(false);
              onSelectPeriod(p.key);
            }}
            aria-pressed={period === p.key}
            className={cn(
              "shrink-0 rounded-full border text-xs transition-colors duration-150 ease-out",
              pill,
              period === p.key
                ? "border-gold/60 bg-gold/15 text-gold"
                : "border-subtle text-muted hover:text-offwhite",
            )}
          >
            {p.label}
          </button>
        ))}
        {/* Any two dates you like - a promo week, last month, a season. */}
        <button
          type="button"
          onClick={() => {
            // Seed the draft from the window on screen, so opening the picker
            // starts where you already are instead of empty.
            setDraftFrom((f) => f || windowStart);
            setDraftTo((t) => t || windowEnd);
            setPickerOpen((v) => !v);
          }}
          aria-pressed={period === "custom"}
          aria-expanded={pickerOpen}
          className={cn(
            "shrink-0 rounded-full border text-xs transition-colors duration-150 ease-out",
            pill,
            period === "custom"
              ? "border-gold/60 bg-gold/15 text-gold"
              : "border-subtle text-muted hover:text-offwhite",
          )}
        >
          {period === "custom" ? periodLabel : "Custom…"}
        </button>
      </div>
      {pickerOpen && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-gold/40 bg-charcoal-800/50 px-3 py-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            From
            <input
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-xs text-offwhite"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            To
            <input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
              className="rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-xs text-offwhite"
            />
          </label>
          <button
            type="button"
            disabled={!draftFrom || !draftTo}
            onClick={() => {
              // Normalize backwards ranges rather than rejecting them.
              const [from, to] =
                draftFrom <= draftTo ? [draftFrom, draftTo] : [draftTo, draftFrom];
              setPickerOpen(false);
              onApplyRange({ from, to });
            }}
            className="rounded-full bg-gold px-3.5 py-1.5 text-xs font-semibold text-charcoal-900 disabled:opacity-50"
          >
            Show this range
          </button>
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted hover:text-offwhite"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
