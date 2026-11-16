/**
 * Open the Assistant panel (HelpBubble) from anywhere on the page, optionally
 * with a question already asked.
 *
 * On the dashboard the panel has no floating button any more: it opens from
 * "Search or ask" in the top bar, from Help in the sidebar, and from the
 * palette's "Ask" row. Those live in different components, so they reach the
 * panel through one window event rather than shared state.
 *
 * The panel answers through `resolveSupport` exactly as before. This only
 * opens it; it never answers anything itself.
 *
 * Returns true when a mounted panel took the request. False means nothing is
 * listening (the panel is hidden on this page, or a test rendered without it),
 * and the caller should fall back to the full Assistant page.
 */
export const OPEN_ASSISTANT_EVENT = "chairback:open-assistant";

export interface OpenAssistantDetail {
  question?: string;
  /**
   * Where focus goes when the panel closes. Needed when the thing that was
   * clicked is about to disappear (the palette's Ask row closes the palette),
   * so the panel would otherwise hand focus back to a detached node.
   */
  returnTo?: HTMLElement | null;
}

export function openAssistant(question?: string, returnTo?: HTMLElement | null): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<OpenAssistantDetail>(OPEN_ASSISTANT_EVENT, {
    detail: { question, returnTo },
    cancelable: true,
  });
  // dispatchEvent returns false when a listener called preventDefault(),
  // which is how the panel says "mine".
  return !window.dispatchEvent(event);
}
