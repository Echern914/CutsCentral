/**
 * Feeding the Lock Screen widget ("Next: Sam · 2:30 PM · Fade").
 *
 * The widget is a separate iOS process that runs while the phone is locked, so
 * it can't read the app's session (keychain, "when unlocked" only - on
 * purpose). The app gives it two things in the shared App Group instead:
 *
 *  - a SNAPSHOT of who's next (GET /api/next-up), so the widget has something
 *    to show with no signal, flipping to the next client at each start time on
 *    its own;
 *  - a WIDGET TOKEN (POST /api/next-up/token) that can read that one route and
 *    nothing else, so the widget refreshes itself between app opens and sees a
 *    booking made after the app was last used.
 *
 * Signing out clears both, so a locked phone handed to someone else shows
 * nothing of the shop - and the server kills the token anyway (tokenVersion).
 *
 * Everything here is injected (fetch, the store, the clock) so it is testable
 * without the native module; src/nextUpWidgetStore.ts is the real store.
 */

export const WIDGET_KEYS = {
  snapshot: "nextUp.snapshot",
  token: "nextUp.token",
  apiOrigin: "nextUp.apiOrigin",
  webOrigin: "nextUp.webOrigin",
} as const;

export interface WidgetStore {
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Ask iOS to rebuild the widget's timeline now. */
  reload(): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RefreshOutcome = "refreshed" | "signed_out" | "failed";

/** Forget everything: what the widget shows after sign-out. */
export function clearNextUpWidget(store: WidgetStore): void {
  for (const key of Object.values(WIDGET_KEYS)) store.remove(key);
  store.reload();
}

export async function refreshNextUpWidget(deps: {
  bearer: string;
  apiOrigin: string;
  webOrigin: string;
  fetch: FetchLike;
  store: WidgetStore;
}): Promise<RefreshOutcome> {
  const auth = { Authorization: `Bearer ${deps.bearer}` };
  let tokenRes: Response;
  let listRes: Response;
  try {
    [tokenRes, listRes] = await Promise.all([
      deps.fetch(`${deps.apiOrigin}/api/next-up/token`, { method: "POST", headers: auth }),
      deps.fetch(`${deps.apiOrigin}/api/next-up`, { headers: auth }),
    ]);
  } catch {
    // Offline: keep what the widget has; it refreshes itself later.
    return "failed";
  }
  // The session is dead (signed out elsewhere, password reset): so is anything
  // the widget holds.
  if (tokenRes.status === 401 || listRes.status === 401) {
    clearNextUpWidget(deps.store);
    return "signed_out";
  }
  if (!tokenRes.ok || !listRes.ok) return "failed";
  let token: unknown;
  let snapshot: string;
  try {
    token = ((await tokenRes.json()) as { token?: unknown }).token;
    snapshot = JSON.stringify(await listRes.json());
  } catch {
    return "failed";
  }
  if (typeof token !== "string" || !token) return "failed";
  deps.store.set(WIDGET_KEYS.token, token);
  deps.store.set(WIDGET_KEYS.snapshot, snapshot);
  deps.store.set(WIDGET_KEYS.apiOrigin, deps.apiOrigin);
  deps.store.set(WIDGET_KEYS.webOrigin, deps.webOrigin);
  deps.store.reload();
  return "refreshed";
}

/**
 * At most one refresh per `minIntervalMs` (foregrounds and booking alerts can
 * arrive in bursts), and never two at once.
 */
export function createWidgetRefresher(run: () => Promise<RefreshOutcome>, minIntervalMs: number, now: () => number) {
  let last = -Infinity;
  let inFlight: Promise<RefreshOutcome> | null = null;
  return {
    refresh(force = false): Promise<RefreshOutcome> | null {
      if (inFlight) return inFlight;
      if (!force && now() - last < minIntervalMs) return null;
      last = now();
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
