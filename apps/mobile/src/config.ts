import Constants from "expo-constants";

/**
 * The web origin the app wraps. Set in app.config.ts (extra.webOrigin), driven
 * by EXPO_PUBLIC_WEB_ORIGIN so a dev build can point at a local server and a
 * store build at production.
 */
export const WEB_ORIGIN: string =
  (Constants.expoConfig?.extra?.webOrigin as string | undefined) ??
  "https://getchairback.com";

/**
 * The API origin (api.getchairback.com). A native app has no browser CSP, so it
 * calls the Express API directly (no Next proxy needed) for things like the
 * cold-start "text me my link" resolver and native push registration.
 */
export const API_ORIGIN: string =
  (Constants.expoConfig?.extra?.apiOrigin as string | undefined) ??
  "https://api.getchairback.com";

/** The customer rewards page for a given magic token. */
export function rewardsUrl(magicToken: string): string {
  return `${WEB_ORIGIN}/r/${magicToken}`;
}

/** The barber dashboard (login persists in the WebView's own cookie jar). */
export function dashboardUrl(): string {
  return `${WEB_ORIGIN}/dashboard`;
}

/** Persisted-choice keys. */
export const STORAGE = {
  mode: "cb.mode", // "barber" | "manager" | "customer"
  lastToken: "cb.customerToken", // last magic token seen, for cold launches
} as const;

/**
 * The 3-way role picker (app/index.tsx) is LIVE: "barber" and "manager" route to
 * the dashboard WebView, "customer" to the rewards WebView.
 *
 * CAVEAT: Google sign-in is blocked inside the embedded WebView (Google's
 * embedded-WebView policy), so barber/manager users must sign in with email +
 * password until native Apple+Google sign-in lands (v2). The customer path needs
 * no login at all (the magic link IS the auth).
 */
