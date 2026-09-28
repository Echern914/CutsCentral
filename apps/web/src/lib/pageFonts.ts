import localFont from "next/font/local";

/**
 * The curated public-page font families, loaded once and exposed as CSS variables
 * (see PAGE_FONTS in config). Shared by the public /s layout AND the dashboard
 * live preview so a shop's typography looks identical in both. next/font requires
 * these calls at module scope.
 *
 * Self-hosted (src/fonts): a build never fetches from Google Fonts. See the
 * README there for why.
 */
const pageInter = localFont({
  src: "../fonts/inter-latin.woff2",
  variable: "--font-page-inter",
  display: "swap",
  weight: "100 900",
});
const pageBricolage = localFont({
  src: "../fonts/bricolage-latin.woff2",
  variable: "--font-page-bricolage",
  display: "swap",
  weight: "200 800",
});
const pagePlayfair = localFont({
  src: "../fonts/playfair-latin.woff2",
  variable: "--font-page-playfair",
  display: "swap",
  weight: "400 900",
});
const pageArchivo = localFont({
  src: "../fonts/archivo-latin.woff2",
  variable: "--font-page-archivo",
  display: "swap",
  weight: "100 900",
});

/** Space-joined className that declares all four --font-page-* CSS variables. */
export const pageFontVars = `${pageInter.variable} ${pageBricolage.variable} ${pagePlayfair.variable} ${pageArchivo.variable}`;
