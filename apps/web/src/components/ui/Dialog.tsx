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

/**
 * THE ON-SCREEN KEYBOARD, WHICH `dvh` CANNOT SEE.
 *
 * `100dvh` tracks the browser's LAYOUT viewport — it follows the iOS URL bar,
 * but not the virtual keyboard, which OVERLAYS the page rather than resizing
 * it. `visualViewport` is the only thing that knows the keyboard is there.
 *
 * 🔴 CAPPING THE PANEL'S HEIGHT IS NOT ENOUGH, and that was the first attempt.
 * The sheet is bottom-anchored on a phone (`items-end`), so shortening it just
 * makes a shorter sheet still pinned to the bottom of the LAYOUT viewport —
 * i.e. still underneath the keyboard, now with less of the form showing. The
 * overlay itself has to move onto the visible rectangle; then `items-end`
 * means "above the keyboard" and the panel gets the whole of what is left.
 *
 * Returns that rectangle, and only while something is actually covering the
 * page. Nothing about the ordinary case depends on this: with no keyboard (or
 * no `visualViewport` at all) it returns null and the overlay stays `inset-0`.
 *
 * The layout height is `max(innerHeight, documentElement.clientHeight)` on
 * purpose. Which of the two stays put when the keyboard opens differs between
 * iOS Safari and a WKWebView, and taking the larger means the keyboard is
 * detected either way — the earlier version used `innerHeight` alone, which
 * silently measured a 0px keyboard in the wrapped app and did nothing at all.
 */
function useViewportRect(open: boolean): { top: number; height: number } | null {
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      const layout = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight,
      );
      const covered = layout - vv.height - vv.offsetTop;
      // 80px is comfortably below any keyboard and comfortably above the
      // few pixels a rubber-band scroll produces.
      setRect(
        covered > 80
          ? { top: Math.round(vv.offsetTop), height: Math.round(vv.height) }
          : null,
      );
    };
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, [open]);
  return rect;
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
  titleAlign = "start",
  leading,
  scrollResetKey,
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
  /**
   * "center" gives the app-sheet header: an optional leading control, the
   * title centered between the two edges, Close on the right. Default stays
   * "start", so every dialog already in the app is untouched.
   */
  titleAlign?: "start" | "center";
  /** A Back control, rendered at the header's leading edge. */
  leading?: React.ReactNode;
  /**
   * Change this whenever the dialog swaps to a different PAGE (detail -> edit
   * -> checkout). The body is one scroll container shared by every page, so
   * without this the new page inherits the old one's scroll position: tapping
   * "Edit appointment" from halfway down the detail view drops you into the
   * middle of the form, which reads as a different, broken screen rather than
   * as the top of the editor.
   */
  scrollResetKey?: string | number;
}) {
  const mounted = useMounted();
  const viewport = useViewportRect(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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
  //
  // 🔴 `mounted` IS LOAD-BEARING IN THIS DEPENDENCY LIST. The first commit
  // renders nothing (useMounted is false until its own effect runs), so on that
  // pass `closeRef.current` is still null and the focus call silently does
  // nothing. Without re-running once the portal exists, focus never entered the
  // dialog at all: it stayed on the trigger behind the scrim, the first Tab
  // went to page content, and a screen reader never announced the dialog.
  // Caught by asserting where focus actually IS after opening, which is the
  // only way this shows up — the trap and the restore both still "worked".
  useEffect(() => {
    if (!open || !mounted) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      // The trigger can unmount with the dialog (a row that re-renders); only
      // restore to something still in the document.
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [open, mounted]);

  // Every page starts at its own top. Runs on CHANGE, not just on mount —
  // the container outlives the page swap, so a mount-only reset would fire
  // once and never again.
  useEffect(() => {
    if (!open) return;
    bodyRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [open, scrollResetKey]);

  const onBackdrop = useCallback(() => closeRefFn.current(), []);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-end justify-center sm:items-center sm:p-4",
        DIALOG_Z,
      )}
      // With a keyboard up, the overlay sits on the VISIBLE rectangle rather
      // than the layout viewport, so `items-end` lands the sheet above the
      // keyboard instead of behind it. `bottom: auto` lets the height win.
      style={
        viewport
          ? { top: viewport.height ? viewport.top : 0, height: viewport.height, bottom: "auto" }
          : undefined
      }
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
          // iOS URL bar, so the panel never hides behind it. With a keyboard
          // up the overlay is already the visible rectangle, so the panel just
          // fills it — which is the whole point: the form gets every pixel the
          // keyboard left, instead of a strip at the bottom of the screen.
          maxHeight: viewport
            ? `${Math.max(viewport.height - 24, 200)}px`
            : "calc(100dvh - 1.5rem)",
        }}
      >
        <div
          data-qa="dialog-header"
          className={cn(
            "flex flex-none gap-3 border-b border-subtle px-4 py-3 sm:px-6 sm:py-4",
            titleAlign === "center"
              ? "items-center justify-between"
              : "items-start justify-between",
          )}
        >
          {/* The leading slot reserves its width even when empty, so a centered
              title is centered on the PANEL rather than on whatever is left
              over next to Close. */}
          {titleAlign === "center" && (
            <div className="flex min-w-[2.75rem] flex-none justify-start">{leading}</div>
          )}
          <div className={cn("min-w-0", titleAlign === "center" && "flex-1 text-center")}>
            <h2
              id={titleId}
              className={cn(
                "text-offwhite",
                titleAlign === "center"
                  ? "text-sm font-medium uppercase tracking-[0.16em]"
                  : "font-display text-base leading-tight sm:text-lg",
              )}
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
            className={cn(
              "-mr-1 flex h-11 min-w-[2.75rem] flex-none items-center justify-center rounded-full border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite",
              titleAlign === "center" ? "sm:h-11" : "sm:h-9",
            )}
          >
            {closeLabel}
          </button>
        </div>

        <div
          ref={bodyRef}
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
