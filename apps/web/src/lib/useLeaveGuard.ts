"use client";

import { useEffect } from "react";

/**
 * Confirm-before-leaving guard for deferred-save editors with unsaved edits.
 * `beforeunload` only covers hard exits (close/refresh/external link) — Next's
 * <Link> navigations are soft and never fire it, and the dashboard's sticky
 * top nav is exactly such links, so without the click interceptor one tap on
 * "Clients" silently discarded a half-configured draft. The capture-phase
 * listeners run before Link's own handler, so cancelling the event genuinely
 * stops the navigation.
 *
 * Extracted from BookingManager (#143) so every deferred-save editor can use
 * it — PageEditor shipped without any guard and was the app's biggest silent
 * data-loss surface.
 */
export function useLeaveGuard(active: boolean, message: string) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // required for the prompt to show in Chrome
    };
    const onClick = (e: MouseEvent) => {
      // Only plain left-clicks navigate in-tab; modified clicks open new tabs
      // and leave the draft alone.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return; // external: beforeunload covers it
      if (url.pathname === window.location.pathname) return; // same page (hash/query)
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onSubmit = (e: Event) => {
      // Server-action forms (the layout's Sign out) navigate too. Plain
      // onSubmit-handled forms have no action attribute — leave those alone.
      const form = e.target as HTMLFormElement | null;
      if (!form || !form.getAttribute("action")) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [active, message]);
}
