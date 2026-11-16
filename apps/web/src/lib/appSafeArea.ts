/**
 * The iPhone home-indicator gap, for the dashboard inside the ChairBack iOS app.
 *
 * 🔴 `env(safe-area-inset-bottom)` reads 0 IN THE APP. The native shell
 * (apps/mobile/app/barber.tsx) insets only the TOP edge, the WebView reaches
 * the bottom of the screen, and AppWebView deliberately does not set
 * `viewport-fit=cover` - which is what makes WebKit report a real inset. So
 * every bottom bar that relied on env() sat under the home indicator: the tab
 * labels on a Face ID iPhone were half covered.
 *
 * The page cannot ask the shell for the number, so it works it out. Every Face
 * ID iPhone is a tall phone (screen ratio about 2.16) with a 34pt indicator in
 * portrait; every home-button iPhone is 16:9 (1.78) with no indicator at all.
 * The ratio survives Display Zoom (a zoomed 12 mini reports 320x693), so
 * "taller than 2:1" picks out exactly the phones that need the gap. The app is
 * locked to portrait (app.config.ts), so the portrait value is the only one.
 *
 * The result goes on `<html>` as `--cb-app-inset-bottom`, which globals.css
 * folds into `--cb-safe-bottom` with max() - so if the app ever does turn on
 * viewport-fit=cover, env() takes over and nothing doubles up.
 */

/** The home indicator's height on every Face ID iPhone in portrait, in px. */
export const HOME_INDICATOR_PX = 34;

/** The slice of `window` the detection reads - small enough to fake in tests. */
export interface AppInsetWindow {
  ReactNativeWebView?: unknown;
  navigator: { userAgent: string };
  screen: { width: number; height: number };
  document: { documentElement: { style: { setProperty(name: string, value: string): void } } };
}

/**
 * Works out the gap and writes it to `--cb-app-inset-bottom`. Returns the px.
 *
 * 🔴 SELF-CONTAINED ON PURPOSE. `APP_INSET_SCRIPT` inlines this function's own
 * SOURCE into the page so the bar is right on the first paint, which means the
 * body may not reference anything outside itself - not even HOME_INDICATOR_PX.
 * Plain ES5 for the same reason: no syntax a compiler would lower to a helper.
 */
export function applyAppBottomInset(w: AppInsetWindow): number {
  var s = w.screen;
  var tall = Math.max(s.width, s.height);
  var narrow = Math.min(s.width, s.height);
  var inset =
    w.ReactNativeWebView && /iPhone|iPod/.test(w.navigator.userAgent) && narrow > 0 && tall / narrow > 2
      ? 34
      : 0;
  w.document.documentElement.style.setProperty("--cb-app-inset-bottom", inset + "px");
  return inset;
}

/**
 * Runs the detection before the dashboard's first paint (rendered as an inline
 * script by dashboard/layout.tsx, beside the theme's PREPAINT_SCRIPT), so the
 * tab bar never draws low and then jumps. `AppBottomInset` runs it again after
 * a client-side navigation, which never executes inline scripts.
 */
export const APP_INSET_SCRIPT = `try{(${applyAppBottomInset.toString()})(window)}catch(e){}`;
