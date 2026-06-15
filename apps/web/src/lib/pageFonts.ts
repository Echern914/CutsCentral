import { Archivo, Bricolage_Grotesque, Inter, Playfair_Display } from "next/font/google";

/**
 * The curated public-page font families, loaded once and exposed as CSS variables
 * (see PAGE_FONTS in config). Shared by the public /s layout AND the dashboard
 * live preview so a shop's typography looks identical in both. next/font requires
 * these calls at module scope.
 */
const pageInter = Inter({ subsets: ["latin"], variable: "--font-page-inter", display: "swap" });
const pageBricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-page-bricolage",
  display: "swap",
});
const pagePlayfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-page-playfair",
  display: "swap",
});
const pageArchivo = Archivo({
  subsets: ["latin"],
  variable: "--font-page-archivo",
  display: "swap",
  weight: ["600", "700", "800"],
});

/** Space-joined className that declares all four --font-page-* CSS variables. */
export const pageFontVars = `${pageInter.variable} ${pageBricolage.variable} ${pagePlayfair.variable} ${pageArchivo.variable}`;
