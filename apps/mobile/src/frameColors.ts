/**
 * The colours of the app's own frame around the dashboard WebView: the cream
 * behind it, the spinner while it loads, and the "Couldn't load" screen.
 *
 * One place on purpose. 1.1.6 turned the frame cream but left the spinner and
 * the error title white, so a slow or failed load looked like a blank white
 * screen with nothing to tap (Drick, 2026-10-20). frameColors.test.ts holds
 * every foreground here to a readable contrast against `bg`.
 */
export const FRAME = {
  bg: "#FAF8F3",
  spinner: "#1C1917",
  title: "#1C1917",
  sub: "#57534E",
  buttonBg: "#1C1917",
  buttonText: "#FAF8F3",
} as const;

/**
 * The bar ABOVE a shop's page inside My ChairBack (customer/WebPage.tsx) - the
 * one with "Done". It wears the PAGE's scheme, which the page reports as
 * `cb:theme:light|dark`. A cream bar over a shop's black booking page read as
 * a white slab on top, and with the page dark the status bar's clock turned
 * white - on cream, so it vanished (Eric, 2026-10-22).
 *
 * `light` is the app's own cream (customer/theme.ts); `dark` is the web's
 * black & gold (globals.css [data-theme="dark"]).
 */
export const PAGE_BAR = {
  light: { bg: "#FAF8F3", title: "#1C1917", tint: "#9A7A1F" },
  dark: { bg: "#0A0A0B", title: "#F5F5F4", tint: "#D4AF37" },
} as const;

export type PageBarScheme = keyof typeof PAGE_BAR;
