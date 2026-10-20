/**
 * Run a server action that LOADS something for a card, and say how it went.
 *
 * A card that reads its data on mount has three outcomes, and before this it
 * handled one: the data arrived. A failed read left the card in its initial
 * empty state - no list, no "none yet", no error - which reads as "you have
 * nothing here" (Drick's Targeted slots card, 2026-10-20: 86 live slots, a
 * blank list).
 *
 * 🔴 A STALE DEPLOYMENT DOES NOT THROW. A page loaded before a website deploy
 * still calls server actions by the ids of the OLD build. On Next 14.2 (checked
 * in node_modules/next 14.2.35, which the lockfile pins, and the same in
 * 14.2.13):
 *
 *  - the server cannot find the id (server/app-render/action-handler.js,
 *    getActionModIdOrError), logs "Failed to find Server Action ... This
 *    request might be from an older or newer deployment." on the SERVER, and
 *    answers with the HTML not-found page;
 *  - the client sees a response that is not `text/x-component`
 *    (client/components/router-reducer/reducers/server-action-reducer.js,
 *    `isFlightResponse` false), so there is no action result and the call
 *    RESOLVES WITH `undefined`.
 *
 * Use this only with actions that never return undefined (every loader here
 * returns an object or null), so `undefined` is the stale-deployment signal.
 * Retrying cannot fix it - the old id is gone for good - so it is told apart
 * from an ordinary failure: the card offers a reload instead of "Try again".
 * (Any other non-RSC answer - a hosting error page - resolves the same way and
 * cannot be told apart; a reload is the right next step for that too.) A thrown error carrying Next's own wording is
 * treated the same, in case a later Next forwards it to the browser.
 *
 * A thrown error is otherwise "failed": the network dropped, or the server
 * action itself crashed.
 *
 * What the action ANSWERED is the caller's to judge - `{ ok: false }` (apiGet's
 * shape for an API, network or timeout failure), a null, an error code that
 * means "hide this card". This only covers the call itself, which is the part
 * every card was getting wrong the same way.
 */
export type LoadFailure = "failed" | "stale";

export type Loaded<T> = { ok: true; value: T } | { ok: false; failure: LoadFailure };

const STALE_DEPLOYMENT = /Failed to find Server Action|older or newer deployment/;

export function isStaleDeploymentError(err: unknown): boolean {
  return err instanceof Error && STALE_DEPLOYMENT.test(err.message);
}

export async function loadAction<T>(call: () => Promise<T>): Promise<Loaded<Exclude<T, undefined>>> {
  let value: T;
  try {
    value = await call();
  } catch (err) {
    return { ok: false, failure: isStaleDeploymentError(err) ? "stale" : "failed" };
  }
  if (value === undefined) return { ok: false, failure: "stale" };
  return { ok: true, value: value as Exclude<T, undefined> };
}
