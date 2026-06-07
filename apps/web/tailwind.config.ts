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
          800: "#141416", // elevated surfaces
          700: "#1C1C1F",
        },
        gold: {
          DEFAULT: "#D4AF37",
          muted: "#B8962F", // hover
          soft: "#E6C964",
        },
        offwhite: "#F5F5F4", // primary text
        muted: "#A1A1AA", // secondary text
        emerald: { soft: "#4ADE80" },
        danger: { soft: "#F87171" },
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
      borderColor: {
        subtle: "rgba(245,245,244,0.08)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      boxShadow: {
        ambient: "0 8px 40px -12px rgba(0,0,0,0.6)",
        glow: "0 0 24px -4px rgba(212,175,55,0.45)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
