/**
 * The last few features a person opened from search or the More sheet, kept
 * in THIS browser only.
 *
 * Ids, never hrefs: the registry resolves an id per seat, so a recent that
 * this seat may no longer open (a flag switched off, a page above their role)
 * simply drops out of the list instead of rendering a link that 403s.
 *
 * localStorage is a convenience here, not state - every read and write is
 * try/catch'd, and an empty list is the correct answer whenever storage is
 * denied (private mode, a thumbnail capture, a browser set to block site data).
 */
const KEY = "cb.recentFeatures";
const MAX = 5;

export function recentFeatureIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberFeature(id: string): void {
  try {
    const next = [id, ...recentFeatureIds().filter((x) => x !== id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage denied - recents are a convenience, the navigation still happens */
  }
}
