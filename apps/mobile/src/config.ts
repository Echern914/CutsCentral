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

/**
 * Native-app session handoff URL. After native Apple/Google sign-in the app has
 * the cb_session JWT but it's in the app's fetch cookie jar, not the WebView's.
 * The barber WebView loads THIS url with the JWT as a Bearer header; the route
 * sets the cb_session cookie and redirects to /dashboard, so the WebView lands
 * authenticated without any native cookie module.
 */
export function appAuthUrl(): string {
  return `${WEB_ORIGIN}/app-auth`;
}

/**
 * The barber-side demo's front door: mints an anonymous READ-ONLY session for
 * the seeded demo tenant and lands on the dashboard with the guided tour armed.
 * This is the app's App Review demonstration mode (Guideline 2.1a) — reviewers
 * (and curious prospects) explore the full dashboard without an account.
 */
export function demoDashboardUrl(): string {
  return `${WEB_ORIGIN}/demo/dashboard`;
}

/**
 * Fixed Client.magicToken of the seeded demo client — the customer-side
 * demonstration mode. Deliberately public (the demo tenant holds no real data
 * and resets nightly); MUST match DEMO.MAGIC_TOKEN in packages/config/src/demo.ts,
 * the contract the demo seeder always restores.
 */
export const DEMO_REWARDS_TOKEN = "demo-rewards-b91e57a3c40d268f7e13";

/** Persisted-choice keys. */
export const STORAGE = {
  mode: "cb.mode", // "barber" | "manager" | "customer"
  lastToken: "cb.customerToken", // last magic token seen, for cold launches
  // The barber/manager cb_session JWT from native sign-in. The WebView's httpOnly
  // cookie can't be read by native, so we keep a copy here to forward as the push
  // registration bearer.
  session: "cb.session",
} as const;

/**
 * The Google iOS OAuth client id (from app.config `extra`). Passed to
 * GoogleSignin.configure({ iosClientId }); with no webClientId, the resulting
 * idToken's `aud` equals this value - exactly what the backend verifies against
 * its GOOGLE_OAUTH_IOS_CLIENT_ID env.
 */
export const GOOGLE_IOS_CLIENT_ID: string =
  (Constants.expoConfig?.extra?.googleIosClientId as string | undefined) ?? "";

/**
 * The 3-way role picker (app/index.tsx) is LIVE: "barber" and "manager" route to
 * the NATIVE Apple/Google sign-in (app/login.tsx) and then the dashboard
 * WebView via the /app-auth cookie handoff. The customer path needs no login at
 * all (the magic link IS the auth). Google's embedded-WebView OAuth block is why
 * sign-in happens natively and why barber.tsx bounces any web /login navigation
 * back to the native screen.
 */
