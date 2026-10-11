/**
 * Noticing that the dashboard inside barber mode has signed out, however it
 * got there, so the APP signs out too. Pure, so it is testable without a
 * WebView; app/barber.tsx is the wiring.
 *
 * 🔴 WHAT WAS WRONG. barber.tsx ran its sign-out (clear the keychain, clear
 * the Lock Screen widget, show the native sign-in screen) only when
 * onShouldStartLoadWithRequest saw a request for /login. But the dashboard's
 * own "Sign out" is a server-action form ending in redirect("/login"), which
 * Next follows IN THE PAGE (history.pushState) - no new navigation, so the
 * WebView never asked. The barber landed on the web email form inside the
 * app, with Apple/Google hidden; the revoked token stayed in the keychain, and
 * the next cold launch replayed it, overwrote the good cookie, and 401'd.
 * "Exit demo" (redirect("/")) and a session expiring mid-dashboard took the
 * same in-page road.
 *
 * Now a script injected before the page runs reports every in-page URL change
 * (pushState, replaceState, back/forward) as a "cb:url" message, and every
 * route in - that message, a real navigation, a navigation-state change - asks
 * the same question: is this URL the signed-out side?
 *
 * Push is not the app's job here: the web's logoutAction calls the API's
 * /api/auth/logout, which drops every device registered to the account in the
 * same transaction that revokes its sessions.
 */

export const URL_CHANGE_MESSAGE = "cb:url";

/**
 * Injected before content loads (main frame only). Wraps history.pushState /
 * replaceState and listens for popstate; posts {type:"cb:url", url} whenever
 * the address changes. It goes in FIRST, so Next's own history patch wraps
 * this one rather than the other way round. Every reference goes through
 * `window` so the test can run it against a stand-in.
 */
export const URL_WATCH_SCRIPT = `
(function () {
  try {
    if (window.__cbUrlWatch) return;
    window.__cbUrlWatch = true;
    var last = null;
    var report = function () {
      try {
        var href = String(window.location.href);
        if (href === last) return;
        last = href;
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: ${JSON.stringify(URL_CHANGE_MESSAGE)}, url: href }));
        }
      } catch (e) {}
    };
    var h = window.history;
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = h[name];
      if (typeof original !== 'function') return;
      h[name] = function () {
        var result = original.apply(this, arguments);
        report();
        return result;
      };
    });
    window.addEventListener('popstate', report);
  } catch (e) {}
})();
true;
`;

export interface SignOutUrlOptions {
  webOrigin: string;
  /** The read-only demo: its "Exit demo" lands on "/", the marketing page. */
  isDemo: boolean;
}

/**
 * Is `url` the signed-out side of OUR web origin? /login always (sign-out,
 * and a session that died mid-dashboard); "/" in the demo (Exit demo).
 */
export function isSignedOutUrl(url: string, opts: SignOutUrlOptions): boolean {
  if (typeof url !== "string" || !url.startsWith(opts.webOrigin)) return false;
  const rest = url.slice(opts.webOrigin.length);
  // A lookalike host (getchairback.com.evil.example) is not our origin.
  if (rest !== "" && !/^[/?#]/.test(rest)) return false;
  const path = rest.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (path === "/login") return true;
  return opts.isDemo && path === "";
}

/** A page message saying the address changed to the signed-out side. */
export function isSignedOutMessage(raw: string, opts: SignOutUrlOptions): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!msg || typeof msg !== "object") return false;
  const { type, url } = msg as { type?: unknown; url?: unknown };
  return type === URL_CHANGE_MESSAGE && typeof url === "string" && isSignedOutUrl(url, opts);
}

/** Run `fn` the first time only: three signals can report one sign-out. */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
