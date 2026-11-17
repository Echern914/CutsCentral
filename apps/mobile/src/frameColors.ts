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
  // Studio paper and ink (web globals.css :root), since 2026-11-17.
  bg: "#F6F4EF",
  spinner: "#1A1814",
  title: "#1A1814",
  sub: "#5E5850",
  buttonBg: "#1A1814",
  buttonText: "#FFFFFF",
} as const;

/**
 * The bar ABOVE a shop's page inside My ChairBack (customer/WebPage.tsx) - the
 * one with "Done". It wears the PAGE's scheme, which the page reports as
 * `cb:theme:light|dark`. A cream bar over a shop's black booking page read as
 * a white slab on top, and with the page dark the status bar's clock turned
 * white - on cream, so it vanished (Eric, 2026-10-22).
 *
 * `light` is the app's own paper (customer/theme.ts); `dark` is the web's
 * Studio dark (globals.css [data-theme="dark"]).
 */
export const PAGE_BAR = {
  light: { bg: "#F6F4EF", title: "#1A1814", tint: "#8A6914" },
  dark: { bg: "#0F0E0C", title: "#F3EFE7", tint: "#D2B062" },
} as const;

export type PageBarScheme = keyof typeof PAGE_BAR;
