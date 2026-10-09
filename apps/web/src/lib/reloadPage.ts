/**
 * A full page reload, as a module of its own so a test can stand it in.
 *
 * jsdom defines `window.location.reload` as non-configurable, so a component
 * that calls it directly can't be tested for WHETHER it reloads, only for
 * not crashing. Callers that reload as a deliberate reset (it clears every
 * piece of in-memory state in one step) use this instead.
 */
export function reloadPage(): void {
  window.location.reload();
}
