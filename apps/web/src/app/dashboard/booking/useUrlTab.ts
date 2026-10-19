"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Keeps the Booking page's tab and its `?tab=` in step, both ways.
 *
 * The tab used to be read from the address ONCE, on first render. A link to
 * another tab of the page you are already on (the "Everything else" menu,
 * the Assistant, a setup checklist: `/dashboard/booking?tab=Services`) is a
 * client-side navigation that keeps this component mounted, so the new value
 * was never read: the sheet closed and you stayed where you were, until the
 * app was closed and reopened (Snow, 2026-10-19).
 *
 *  - The address changes -> ask for that tab (`onRequest`, which may refuse:
 *    unsaved group edits). A refusal puts the address back on the tab shown.
 *  - The tab changes (the tab bar, a tour) -> the address follows, so the
 *    NEXT link to a tab is always a change this hook can see. Without that, a
 *    second tap on the same menu entry after using the tab bar would be a
 *    no-op again.
 */
export function useUrlTab<T extends string>({
  tabs,
  current,
  onRequest,
}: {
  tabs: readonly T[];
  current: T;
  /** Switch to `next`; false when it was refused. */
  onRequest: (next: T) => boolean;
}) {
  const params = useSearchParams();
  const raw = params?.get("tab") ?? null;
  const wanted = raw !== null && (tabs as readonly string[]).includes(raw) ? (raw as T) : null;

  // Latest values for the effects without re-running them on every render.
  const currentRef = useRef(current);
  currentRef.current = current;
  const requestRef = useRef(onRequest);
  requestRef.current = onRequest;

  useEffect(() => {
    if (wanted === null || wanted === currentRef.current) return;
    if (!requestRef.current(wanted)) writeTab(currentRef.current);
  }, [wanted]);

  // Not on the first render: the address is what chose the first tab.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    writeTab(current);
  }, [current]);
}

function writeTab(tab: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("tab") === tab) return;
  url.searchParams.set("tab", tab);
  // Next 14.1+ keeps useSearchParams in step with history.replaceState, with
  // no server round trip and no new history entry for a tab change.
  window.history.replaceState(null, "", url);
}
