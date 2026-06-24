import Constants from "expo-constants";

/**
 * The web origin the app wraps. Set in app.config.ts (extra.webOrigin), driven
 * by EXPO_PUBLIC_WEB_ORIGIN so a dev build can point at a local server and a
 * store build at production.
 */
export const WEB_ORIGIN: string =
  (Constants.expoConfig?.extra?.webOrigin as string | undefined) ??
  "https://getchairback.com";

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
  mode: "cb.mode", // "customer" | "barber"
  lastToken: "cb.customerToken", // last magic token seen, for cold launches
} as const;

/**
 * Barber mode is OFF for v1: it logs into the dashboard WebView where Google's
 * OAuth is blocked (embedded-WebView policy). It turns back on once native
 * Apple+Google sign-in lands (v2). While off, the app is purely the customer
 * rewards experience (magic link -> rewards), which needs no login at all.
 */
export const BARBER_MODE_ENABLED = false;
