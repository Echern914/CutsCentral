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
