"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * The shared modal dialog: a portal to `document.body`, a full-viewport
 * backdrop, a scroll-locked page behind it, and a panel that is guaranteed to
 * fit the viewport with its header and footer always reachable.
 *
 * 🔴 WHY THIS EXISTS — the bug it was extracted to kill:
 *
 * `position: fixed` is only viewport-relative while NO ancestor establishes a
 * containing block for fixed descendants. `backdrop-filter` does exactly that
 * (CSS Filter Effects §containing block), and `.glass` — the workhorse Card
 * surface on every dashboard page — sets `backdrop-filter: blur(14px)`.
 *
 * So a modal rendered INSIDE a <Card> gets:
 *   - `fixed inset-0` sized to the CARD, not the viewport — the backdrop dims
 *     a rectangle around one card and leaves the header, nav and the rest of
 *     the page bright;
 *   - its `z-50` trapped inside the card's stacking context (backdrop-filter
 *     creates one), so every LATER sibling card on the page — each its own
 *     stacking context at z-index:auto, painted in DOM order — draws OVER the
 *     modal. Raising the z-index cannot fix this; only leaving the subtree can.
 *   - a panel whose `max-h: …dvh` is measured against the viewport while its
 *     position is measured against the card, so it hangs off the bottom of the
 *     screen and takes the footer's buttons with it.
 *
 * Portaling to `document.body` is therefore not a nicety — it is the only
 * placement where a dialog's own CSS means what it says.
 *
 * Owns, so no call site has to: focus trap, focus restore, Escape, backdrop
 * click, body scroll lock, `role="dialog"` + `aria-modal` + an accessible name.
 *
 * Layout contract for the panel:
 *   flex column, `max-height: calc(100dvh - gutter)`, `overflow: hidden`
 *   ├─ header  (flex-none — stays put while the body scrolls)
 *   ├─ body    (`min-h-0 flex-1 overflow-y-auto` — 🔴 `min-h-0` is load-bearing:
 *   │           a flex item defaults to `min-height:auto`, which refuses to
 *   │           shrink below its content, so WITHOUT it the body pushes the
 *   │           footer out of the panel and nothing scrolls internally)
 *   └─ footer  (flex-none — the primary action is never scrolled away)
 */

/** Above every other layer in the app (tour 120, pull-to-refresh 70, nav 30). */
const DIALOG_Z = "z-[200]";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
  labelId,
  className,
  closeLabel = "Close",
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog's accessible name. */
  title: string;
  subtitle?: string;
  /** Sticky footer content — the final action lives here. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** Override the generated id used by aria-labelledby. */
  labelId?: string;
  /** Extra classes for the panel (max-width lives here). */
  className?: string;
  closeLabel?: string;
}) {
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const generatedId = useId();
  const titleId = labelId ?? `dlg-${generatedId}`;

  // Latest onClose without making the effects below depend on its identity —
  // an inline arrow at the call site is a new function every render, and a
  // dependency on it would tear down and rebuild the listeners (and re-run the
  // scroll lock) on every keystroke inside the dialog.
  const closeRefFn = useRef(onClose);
  closeRefFn.current = onClose;

  // Escape + focus trap. One keydown listener owns both.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRefFn.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed",
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // Wrap at both ends, and pull focus back in if it ever escaped the panel
      // (a browser can hand it to the address bar or to page content behind).
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Lock the page behind the dialog, and give back the exact scrollbar width so
  // a desktop page does not jump sideways when its scrollbar disappears.
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gutter > 0) body.style.paddingRight = `${gutter}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
    };
  }, [open]);

  // Move focus in on open; put it back where it came from on close.
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      // The trigger can unmount with the dialog (a row that re-renders); only
      // restore to something still in the document.
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [open]);

  const onBackdrop = useCallback(() => closeRefFn.current(), []);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-end justify-center sm:items-center sm:p-4",
        DIALOG_Z,
      )}
      data-qa="dialog-overlay"
    >
      {/* Full-viewport scrim. `fixed`, not `absolute`, so it covers the header,
          the nav pill and the mobile safe areas no matter what the overlay's
          own box ends up being. */}
      <button
        type="button"
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={onBackdrop}
        data-qa="dialog-backdrop"
        // Literal black, like every other overlay in the app (MoreSheet,
        // FeatureSearch, AppointmentForm). A scrim is one of the few surfaces
        // that must NOT flip with the theme: `bg-charcoal` is warm white under
        // [data-theme="light"], which would wash the page out instead of
        // pushing it back.
        className="fixed inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-qa="dialog-panel"
        className={cn(
          // `min-h-0` + `overflow-hidden` keep the scroll INSIDE the body below.
          "glass relative flex w-full min-h-0 flex-col overflow-hidden rounded-t-3xl shadow-ambient-lg sm:rounded-3xl",
          className,
        )}
        style={{
          // The gutter is smaller on phones (the sheet is meant to sit close to
          // the edges) and roomier once the dialog floats. `dvh` follows the
          // iOS URL bar, so the panel never hides behind it.
          maxHeight: "calc(100dvh - 1.5rem)",
        }}
      >
        <div
          data-qa="dialog-header"
          className="flex flex-none items-start justify-between gap-3 border-b border-subtle px-4 py-3 sm:px-6 sm:py-4"
        >
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-display text-base leading-tight text-offwhite sm:text-lg"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-xs leading-snug text-muted">{subtitle}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            // 44px touch target; the visible pill is centered inside it.
            className="-mr-1 flex h-11 min-w-[2.75rem] flex-none items-center justify-center rounded-full border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite sm:h-9"
          >
            {closeLabel}
          </button>
        </div>

        <div
          data-qa="dialog-body"
          // 🔴 min-h-0: without it this item will not shrink below its content
          // and the footer is pushed off the bottom of the panel.
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 sm:px-6"
        >
          {children}
        </div>

        {footer && (
          <div
            data-qa="dialog-footer"
            className="flex flex-none flex-col gap-2 border-t border-subtle bg-charcoal-900/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6"
            // The sheet is the bottom-most surface on a phone, so it owns the
            // home-indicator gap. env() reads 0 today (the app deliberately does
            // NOT set viewport-fit=cover — see globals.css) and turns itself on
            // if that ever changes; nothing moves in the meantime.
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
