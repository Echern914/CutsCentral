import type { Config } from "tailwindcss";

/**
 * ChairBack design tokens. Premium dark barbershop feel - charcoal + warm gold,
 * no pure #fff/#000, subtle 1px borders over heavy shadows.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        charcoal: {
          DEFAULT: "#0A0A0B", // base background
          900: "#0E0E10",
          800: "#141416", // elevated surfaces
          700: "#1C1C1F",
          600: "#26262B",
        },
        gold: {
          DEFAULT: "#D4AF37",
          muted: "#B8962F", // hover
          soft: "#E6C964",
          deep: "#8C6E1B",
        },
        offwhite: "#F5F5F4", // primary text
        muted: "#A1A1AA", // secondary text
        emerald: { soft: "#4ADE80" },
        danger: { soft: "#F87171" },
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },
      borderColor: {
        subtle: "rgba(245,245,244,0.08)",
        "subtle-strong": "rgba(245,245,244,0.14)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      boxShadow: {
        ambient: "0 8px 40px -12px rgba(0,0,0,0.6)",
        "ambient-lg": "0 24px 80px -24px rgba(0,0,0,0.8)",
        glow: "0 0 24px -4px rgba(212,175,55,0.45)",
        "glow-lg": "0 0 64px -8px rgba(212,175,55,0.5)",
        "glow-sm": "0 0 12px -2px rgba(212,175,55,0.35)",
        "inner-top": "inset 0 1px 0 0 rgba(245,245,244,0.06)",
      },
      backgroundImage: {
        "gold-gradient": "linear-gradient(135deg, #E6C964 0%, #D4AF37 55%, #B8962F 100%)",
        "gold-text": "linear-gradient(120deg, #F1DD8C 0%, #D4AF37 45%, #E6C964 100%)",
        "card-sheen":
          "linear-gradient(180deg, rgba(245,245,244,0.045) 0%, rgba(245,245,244,0) 40%)",
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
          "0%, 100%": { boxShadow: "0 0 24px -6px rgba(212,175,55,0.35)" },
          "50%": { boxShadow: "0 0 42px -6px rgba(212,175,55,0.6)" },
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
