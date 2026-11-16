import type { Config } from "tailwindcss";

/**
 * ChairBack design tokens - "Studio" (2026-11-16). Warm paper and white
 * surfaces, near-black ink for primary actions, and gold kept as a SIGNAL
 * (rewards, the brand mark, "now", selected days) - never as a button.
 * Dark mode is the same system in black and brass ("Noir").
 *
 *   bg-primary text-on-primary   the one primary action (ink on light, cream on dark)
 *   bg-gold                      a gold FILL (#C19A3B) - dots, bars, punches
 *   text-gold / border-gold      gold INK (#8A6914) - AA as text on white
 *
 * Flat surfaces, 1px lines, small radii (8 / 10 / 14). No glows, no gradients,
 * no glass blur: those read as a template, not as a product.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Every color is a CSS variable (R G B channels, defined in globals.css)
      // so the LIGHT theme can flip the whole app by remapping variables under
      // [data-theme="light"] - no component ever changes its class names. The
      // :root values are byte-identical to the old hex, so dark mode renders
      // exactly as before. `<alpha-value>` keeps /50-style opacity modifiers
      // working.
      colors: {
        charcoal: {
          DEFAULT: "rgb(var(--cb-bg) / <alpha-value>)", // base background
          900: "rgb(var(--cb-s900) / <alpha-value>)",
          800: "rgb(var(--cb-s800) / <alpha-value>)", // elevated surfaces
          700: "rgb(var(--cb-s700) / <alpha-value>)",
          600: "rgb(var(--cb-s600) / <alpha-value>)",
        },
        gold: {
          DEFAULT: "rgb(var(--cb-gold) / <alpha-value>)",
          muted: "rgb(var(--cb-gold-muted) / <alpha-value>)", // hover
          soft: "rgb(var(--cb-gold-soft) / <alpha-value>)",
          deep: "rgb(var(--cb-gold-deep) / <alpha-value>)",
        },
        offwhite: "rgb(var(--cb-fg) / <alpha-value>)", // primary text
        // The primary action: ink on the light theme, cream on the dark one.
        primary: "rgb(var(--cb-primary) / <alpha-value>)",
        "on-primary": "rgb(var(--cb-on-primary) / <alpha-value>)",
        // Text ON the literal gold gradient: that metal is bright in BOTH
        // themes, so its text is dark in both (charcoal flips to white in light).
        "on-gold": "#1C1917",
        muted: "rgb(var(--cb-fg-muted) / <alpha-value>)", // secondary text
        emerald: { soft: "rgb(var(--cb-emerald) / <alpha-value>)" },
        danger: { soft: "rgb(var(--cb-danger) / <alpha-value>)" },
        indigo: { soft: "rgb(var(--cb-indigo) / <alpha-value>)" },
        // Status colours that flip with the theme: pale on charcoal, deep on
        // white. Use these, never a raw amber-300 / sky-300 (unreadable on white).
        warning: { soft: "rgb(var(--cb-warning) / <alpha-value>)" },
        info: { soft: "rgb(var(--cb-info) / <alpha-value>)" },
      },
      // A gold BACKGROUND is the brighter fill gold; gold TEXT and BORDERS keep
      // the deeper ink gold that reads at AA on white. Tints (bg-gold/10) take
      // the fill, which is what makes them warm instead of muddy.
      backgroundColor: {
        gold: { DEFAULT: "rgb(var(--cb-gold-fill) / <alpha-value>)" },
      },
      // Studio radii: 8 (chips), 10 (buttons, inputs), 14 (cards), 16+ (sheets).
      borderRadius: {
        xl: "0.625rem",
        "2xl": "0.875rem",
        "3xl": "1rem",
        "4xl": "1.25rem",
      },
      // Borders derive from the FOREGROUND color so they flip with the theme
      // (light ink hairlines on white, warm-white ones on charcoal). The alpha
      // is its own variable: 8% white reads on charcoal, but 8% near-black
      // disappears on white, so light mode runs the hairlines slightly harder.
      borderColor: {
        subtle: "rgb(var(--cb-fg) / var(--cb-border-a))",
        "subtle-strong": "rgb(var(--cb-fg) / var(--cb-border-a-strong))",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        // Titles are Inter too, set tighter (globals.css `.font-display`). The
        // old display face lives on only as a shop-page font choice (/s).
        display: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        // Ambient depth shadows: pitch black at 60-80% on charcoal would read
        // as dirt on white, so the color AND alpha are per-theme variables.
        ambient: "0 1px 2px rgb(var(--cb-shadow) / var(--cb-shadow-a)), 0 8px 24px -12px rgb(var(--cb-shadow) / var(--cb-shadow-a))",
        "ambient-lg": "0 2px 4px rgb(var(--cb-shadow) / var(--cb-shadow-a)), 0 24px 48px -24px rgb(var(--cb-shadow) / var(--cb-shadow-a-lg))",
        // The gold glows are retired. The names stay (shop pages and string-built
        // classes may still say them) but they now draw a plain, quiet lift.
        glow: "0 1px 2px rgb(var(--cb-shadow) / var(--cb-shadow-a))",
        "glow-lg": "0 1px 2px rgb(var(--cb-shadow) / var(--cb-shadow-a))",
        "glow-sm": "0 1px 2px rgb(var(--cb-shadow) / var(--cb-shadow-a))",
        "inner-top": "none",
      },
      backgroundImage: {
        // Gradients are retired: a gold FILL is one flat gold. The names stay
        // so nothing that still says them renders unstyled.
        "gold-gradient": "linear-gradient(rgb(var(--cb-gold-fill)), rgb(var(--cb-gold-fill)))",
        "gold-text": "linear-gradient(rgb(var(--cb-gold)), rgb(var(--cb-gold)))",
        "card-sheen": "none",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        float: "float 7s ease-in-out infinite",
        "fade-in": "fade-in 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
