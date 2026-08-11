"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, type Theme } from "@/lib/theme";

/**
 * The two looks, as tap-to-choose swatch cards: Black & Gold (the original) and
 * White & Gold. Shared by onboarding ("pick your look") and the Account page's
 * Appearance card so the choice renders identically in both places.
 *
 * The preview swatches are LITERAL colors on purpose - each card must show what
 * that theme looks like regardless of which theme is currently active, so they
 * cannot use the token variables they are advertising.
 *
 * Applies instantly (the whole dashboard flips under the tap - that IS the
 * preview), then persists via the callback; if persistence fails the caller's
 * toast says so, but the visual choice stays - it will simply not follow the
 * account to another device until a later save succeeds.
 */
export function ThemePicker({
  value,
  onPick,
}: {
  value: Theme;
  /** Persist the choice (PATCH /api/auth/me). Called after the instant apply. */
  onPick: (theme: Theme) => void | Promise<void>;
}) {
  const [current, setCurrent] = useState<Theme>(value);

  function choose(theme: Theme) {
    setCurrent(theme);
    applyTheme(theme); // instant - the app flipping is the preview
    void onPick(theme);
  }

  const swatch = (
    theme: Theme,
    label: string,
    sub: string,
    colors: { bg: string; card: string; text: string },
  ) => {
    const selected = current === theme;
    return (
      <button
        type="button"
        onClick={() => choose(theme)}
        aria-pressed={selected}
        className={cn(
          "flex-1 rounded-2xl border p-3 text-left transition-colors",
          selected ? "border-gold" : "border-subtle hover:border-subtle-strong",
        )}
      >
        {/* Miniature of the theme: page bg, a card, a line of text, a gold dot. */}
        <span
          className="block rounded-xl border border-black/10 p-2.5"
          style={{ backgroundColor: colors.bg }}
        >
          <span
            className="block rounded-lg px-2 py-1.5"
            style={{ backgroundColor: colors.card }}
          >
            <span
              className="block h-1.5 w-12 rounded-full"
              style={{ backgroundColor: colors.text }}
            />
            <span className="mt-1 flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: "#D4AF37" }}
              />
              <span
                className="inline-block h-1 w-8 rounded-full opacity-50"
                style={{ backgroundColor: colors.text }}
              />
            </span>
          </span>
        </span>
        <span className="mt-2 block text-sm font-medium text-offwhite">
          {label}
          {selected && <span className="ml-2 text-xs text-gold">✓ current</span>}
        </span>
        <span className="block text-xs text-muted">{sub}</span>
      </button>
    );
  };

  return (
    <div className="flex gap-3" role="group" aria-label="Dashboard appearance">
      {swatch("dark", "Black & Gold", "The original. Easy on late-night eyes.", {
        bg: "#0A0A0B",
        card: "#141416",
        text: "#F5F5F4",
      })}
      {swatch("light", "White & Gold", "Bright and clean. Great in daylight.", {
        bg: "#FAF8F3",
        card: "#FFFFFF",
        text: "#1C1917",
      })}
    </div>
  );
}
