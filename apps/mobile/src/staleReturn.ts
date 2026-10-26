/**
 * When the app comes back to the front, is its web page too old to trust?
 *
 * The app keeps one WebView alive for days. A website deploy while it sat in
 * the background leaves that page calling the old build's server actions,
 * which no longer exist, so every card that loads on its own came up empty
 * (Drick's Targeted slots, 2026-10-20: 87 live slots, a blank list). A page
 * the barber left this long ago is reloaded on return; a quick app switch
 * (answering a text mid-checkout) keeps the page and whatever is typed in it.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export function shouldReloadOnReturn(leftAt: number | null, now: number): boolean {
  return leftAt !== null && now - leftAt >= STALE_AFTER_MS;
}

/**
 * 🔴 IS THE PAGE STILL THERE? A short trip to the background can still cost
 * the page: iOS may drop the WebView's web content without the app ever being
 * told (no process-terminated callback), and the barber comes back to a blank
 * view that nothing notices - the only way out was a force-quit (Luigi,
 * 2026-10-26). On every return the app asks the page to answer; no answer in
 * ALIVE_TIMEOUT_MS = start a fresh page.
 */
export const ALIVE_PING = "cb:alive";
export const ALIVE_TIMEOUT_MS = 2000;
/** The script that asks: a live page answers at once; a dead one cannot. */
export const ALIVE_PROBE_JS = `(function(){try{window.ReactNativeWebView.postMessage(${JSON.stringify(ALIVE_PING)});}catch(e){}})();true;`;

/** On return, ask only when a page should be showing - not mid-load, not on the error screen, not when a stale reload is already starting. */
export function shouldProbeOnReturn(p: { leftAt: number | null; loading: boolean; errored: boolean; reloading: boolean }): boolean {
  return p.leftAt !== null && !p.loading && !p.errored && !p.reloading;
}
