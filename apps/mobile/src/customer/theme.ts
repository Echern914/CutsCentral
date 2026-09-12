import { Platform, type TextStyle } from "react-native";

/**
 * My ChairBack's visual system.
 *
 * The same near-black and gold the rest of ChairBack speaks (web globals.css
 * --cb-* tokens; the role picker's COLORS), spent with restraint: gold is for
 * the one primary action on a screen, progress, and the brand mark - never a
 * wash, never a glow. Separation comes from surfaces and hairlines, not
 * shadows. Status is carried by a WORD plus a small dot, never by colour
 * alone, and red is deliberately absent: a no-show is a muted coral, a
 * cancellation a quiet grey.
 */
export const color = {
  bg: "#0A0A0B",
  surface: "#141416",
  surfaceRaised: "#1C1C1F",
  surfacePressed: "#232327",
  hairline: "rgba(245,245,244,0.08)",
  hairlineStrong: "rgba(245,245,244,0.14)",
  text: "#F5F5F4",
  textSecondary: "#A1A1AA",
  textTertiary: "#77777F",
  gold: "#D4AF37",
  goldText: "#E6C964",
  goldTint: "rgba(212,175,55,0.14)",
  onGold: "#0A0A0B",
  focus: "#E6C964",
} as const;

/** The dot beside each status word. Muted, and never the only signal. */
export const statusColor = {
  requested: "#F2B84B",
  booked: "#D4AF37",
  completed: "#6FCF97",
  canceled: "#8A8A92",
  no_show: "#E08A7B",
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

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
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

/** The brand display face, loaded by the root layout; system face if it failed. */
export const WORDMARK_FONT = "BricolageGrotesque_700Bold";
