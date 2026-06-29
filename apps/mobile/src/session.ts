import CookieManager from "@preeternal/react-native-cookie-manager";
import { WEB_ORIGIN } from "./config";

/**
 * Write the backend session JWT into BOTH iOS cookie stores under the apex
 * domain so the dashboard WebView loads ALREADY authenticated.
 *
 * Call AFTER the native Apple/Google sign-in POST returns { token }, and BEFORE
 * rendering /dashboard. Best-effort: the caller should still proceed on failure
 * (the WebView then falls back to its own in-page login).
 *
 * iOS has two cookie stores: react-native-webview's WKWebView reads
 * WKHTTPCookieStore (useWebKit:true); `sharedCookiesEnabled` mirrors
 * NSHTTPCookieStorage (useWebKit:false). We write both so the cookie is present
 * no matter which the WebView consults on a cold launch.
 *
 * domain is the leading-dot apex `.getchairback.com` to match the cookie the
 * web/api set, so it covers getchairback.com where /dashboard lives.
 */
export async function installSessionCookie(token: string): Promise<void> {
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const cookie = {
    name: "cb_session",
    value: token,
    domain: ".getchairback.com",
    path: "/",
    secure: true,
    httpOnly: true,
    expires,
  } as const;
  await CookieManager.set(WEB_ORIGIN, cookie, true); // WKHTTPCookieStore
  await CookieManager.set(WEB_ORIGIN, cookie, false); // NSHTTPCookieStorage
}
