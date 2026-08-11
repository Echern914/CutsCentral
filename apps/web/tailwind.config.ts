import type { Config } from "tailwindcss";

/**
 * ChairBack design tokens. Premium dark barbershop feel - charcoal + warm gold,
 * no pure #fff/#000, subtle 1px borders over heavy shadows.
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
        muted: "rgb(var(--cb-fg-muted) / <alpha-value>)", // secondary text
        emerald: { soft: "rgb(var(--cb-emerald) / <alpha-value>)" },
        danger: { soft: "rgb(var(--cb-danger) / <alpha-value>)" },
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
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
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      boxShadow: {
        // Ambient depth shadows: pitch black at 60-80% on charcoal would read
        // as dirt on white, so the color AND alpha are per-theme variables.
        ambient: "0 8px 40px -12px rgb(var(--cb-shadow) / var(--cb-shadow-a))",
        "ambient-lg": "0 24px 80px -24px rgb(var(--cb-shadow) / var(--cb-shadow-a-lg))",
        glow: "0 0 24px -4px rgb(var(--cb-gold) / 0.45)",
        "glow-lg": "0 0 64px -8px rgb(var(--cb-gold) / 0.5)",
        "glow-sm": "0 0 12px -2px rgb(var(--cb-gold) / 0.35)",
        "inner-top": "inset 0 1px 0 0 rgb(var(--cb-sheen) / 0.06)",
      },
      backgroundImage: {
        // The gold gradients stay literal: they are the brand's metal, used as
        // FILLS under dark text, and the same bar of gold reads correctly on
        // charcoal and on white. Only the sheen (a white glaze for dark cards)
        // is variable - on white cards it fades to nothing instead of graying.
        "gold-gradient": "linear-gradient(135deg, #E6C964 0%, #D4AF37 55%, #B8962F 100%)",
        "gold-text": "linear-gradient(120deg, #F1DD8C 0%, #D4AF37 45%, #E6C964 100%)",
        "card-sheen":
          "linear-gradient(180deg, rgb(var(--cb-sheen) / 0.045) 0%, rgb(var(--cb-sheen) / 0) 40%)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 24px -6px rgb(var(--cb-gold) / 0.35)" },
          "50%": { boxShadow: "0 0 42px -6px rgb(var(--cb-gold) / 0.6)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        float: "float 7s ease-in-out infinite",
        "pulse-glow": "pulse-glow 4s ease-in-out infinite",
        "fade-in": "fade-in 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
