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
