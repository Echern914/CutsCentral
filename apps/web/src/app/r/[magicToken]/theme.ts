import type { CSSProperties } from "react";
import {
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_PAGE_FONT,
  LAYOUT_STYLES,
  PAGE_FONTS,
  PAGE_THEMES,
  type LayoutStyleKey,
  type PageFontKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { readableOn } from "@/lib/contrast";
import type { RewardsData } from "./page";

/**
 * Resolved visual identity for the client rewards page, derived from the shop's
 * stored page settings (the SAME keys the public /s/[slug] mini-site reads). The
 * rewards page and its child components render against these tokens instead of
 * the app's dark-chrome utility classes, so a client's loyalty page looks like
 * an extension of their barber's shop - their colors, type, and shape.
 */
export interface RewardsTheme {
  /** Page background. */
  bg: string;
  /** Card/raised surface background. */
  surface: string;
  /** Hairline/border color. */
  border: string;
  /** Primary text color. */
  text: string;
  /** Secondary/muted text color. */
  muted: string;
  /** Brand accent (shop override or the theme's accent). */
  accent: string;
  /** Readable foreground to sit ON the accent (for filled chips/buttons). */
  onAccent: string;
  /** "light" | "dark" - drives native form-control coloring via color-scheme. */
  scheme: "light" | "dark";
  /** Corner radius for cards/surfaces. */
  radius: string;
  /** Button/pill radius. */
  buttonRadius: string;
}

/** Resolve a shop's stored page keys into concrete render tokens. */
export function resolveRewardsTheme(shop: RewardsData["shop"]): RewardsTheme {
  const theme =
    PAGE_THEMES[(shop.theme as PageThemeKey) in PAGE_THEMES ? (shop.theme as PageThemeKey) : "classic"];
  const accent = shop.accentColor || theme.accent;
  const layoutKey: LayoutStyleKey =
    (shop.layoutStyle as LayoutStyleKey) in LAYOUT_STYLES
      ? (shop.layoutStyle as LayoutStyleKey)
      : DEFAULT_LAYOUT_STYLE;
  const layout = LAYOUT_STYLES[layoutKey];
  return {
    bg: theme.bg,
    surface: theme.surface,
    border: theme.border,
    text: theme.text,
    muted: theme.muted,
    accent,
    // Derived from the accent's own luminance, not the theme scheme: shops pick
    // arbitrary accents, and a fixed foreground fails WCAG 1.4.3 on the wrong
    // half of the color space (e.g. white text on a pale yellow accent).
    onAccent: readableOn(accent),
    scheme: theme.scheme,
    radius: layout.radius,
    buttonRadius: layout.buttonRadius,
  };
}

/** The CSS font-family vars to pick from the shop's font pairing. */
export function rewardsFontVars(shop: RewardsData["shop"]): {
  display: string;
  body: string;
} {
  const fontKey: PageFontKey =
    (shop.fontKey as PageFontKey) in PAGE_FONTS ? (shop.fontKey as PageFontKey) : DEFAULT_PAGE_FONT;
  const font = PAGE_FONTS[fontKey];
  return {
    display: `var(${font.displayVar}), Georgia, serif`,
    body: `var(${font.bodyVar}), system-ui, sans-serif`,
  };
}

/** A bordered surface style (card background + hairline + radius). */
export function surfaceStyle(t: RewardsTheme): CSSProperties {
  return {
    backgroundColor: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: t.radius,
  };
}
