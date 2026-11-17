import { Platform, type TextStyle } from "react-native";

/**
 * My ChairBack's visual system: Studio, the same look as the web
 * (apps/web globals.css :root, the 2026-11-16 redesign).
 *
 * Paper and ink. The ONE primary action on a screen is an ink button with
 * white text; gold is an accent only - links, the selected tab, progress,
 * stamps - never a button fill. Separation comes from white surfaces and
 * hairlines, not shadows. Status is carried by a WORD plus a small dot, never
 * by colour alone.
 */
export const color = {
  bg: "#F6F4EF", // paper
  surface: "#FFFFFF",
  // Field: tiles, secondary buttons, tracks (web s700).
  surfaceRaised: "#EFECE5",
  surfacePressed: "#E6E2D9",
  hairline: "rgba(26,24,20,0.11)",
  hairlineStrong: "rgba(26,24,20,0.18)",
  text: "#1A1814", // ink
  textSecondary: "#5E5850",
  textTertiary: "#776F64",
  // The primary button: ink with white text.
  primary: "#1A1814",
  primaryPressed: "#38342D",
  onPrimary: "#FFFFFF",
  // Gold FILL: stamps, progress, the unread dot. Ink text on it.
  gold: "#C19A3B",
  // Gold as TEXT: gold ink, readable on white (~5.4:1).
  goldText: "#8A6914",
  goldTint: "rgba(138,105,20,0.10)",
  onGold: "#1A1814",
  focus: "#8A6914",
} as const;

/** The dot beside each status word: the web's status colours. Never the only signal. */
export const statusColor = {
  requested: "#9A5B0B",
  booked: "#8A6914",
  completed: "#1E7A4C",
  canceled: "#776F64",
  no_show: "#B3261E",
} as const;

/** 8-point spacing. `half` exists for the few optical adjustments that need it. */
export const space = {
  half: 4,
  s1: 8,
  s2: 16,
  s3: 24,
  s4: 32,
  s5: 40,
  s6: 48,
} as const;

// Studio's radius scale (web rounded-xl 10, 2xl 14, 3xl 16, 4xl 20).
export const radius = {
  sm: 8,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** The minimum interactive size (Apple HIG). Every control is at least this. */
export const TOUCH = 44;

/**
 * iOS text styles (SF Pro via the system font). Sizes and leading follow
 * Apple's Large (default) content size; React Native scales them with the
 * user's Dynamic Type setting automatically, so every layout below must
 * survive text roughly twice this size.
 */
const system = Platform.select({ ios: undefined, default: undefined });

function style(size: number, lineHeight: number, weight: TextStyle["fontWeight"], tracking = 0): TextStyle {
  return { fontFamily: system, fontSize: size, lineHeight, fontWeight: weight, letterSpacing: tracking };
}

export const type = {
  largeTitle: style(34, 41, "700", 0.37),
  title1: style(28, 34, "700", 0.36),
  title2: style(22, 28, "700", 0.35),
  title3: style(20, 25, "600", 0.38),
  headline: style(17, 22, "600", -0.41),
  body: style(17, 22, "400", -0.41),
  callout: style(16, 21, "400", -0.32),
  subhead: style(15, 20, "400", -0.24),
  subheadStrong: style(15, 20, "600", -0.24),
  footnote: style(13, 18, "400", -0.08),
  footnoteStrong: style(13, 18, "600", -0.08),
  caption: style(12, 16, "400", 0),
  captionStrong: style(12, 16, "600", 0),
} as const;

export type TypeStyle = keyof typeof type;

/**
 * The wordmark face. Studio draws ChairBack in the system face, semibold and
 * tight (the web's Inter 600, -0.02em); Bricolage is kept for shop pages.
 * Undefined = the system font.
 */
export const WORDMARK_FONT: string | undefined = undefined;
