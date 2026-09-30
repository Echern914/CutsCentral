"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";
import type { PagePhoto } from "../page";
import { bookPickedHref, photoMeta, photoTitle, serviceOf, staffOf, type DesignCtx } from "./model";

/**
 * A photo, full screen: what it is, who did it, and one tap to book that exact
 * service with that person already picked - the page's photos stop being a
 * picture and start being a way in.
 *
 * A real dialog: focus moves in and stays in (Tab wraps), Escape closes, focus
 * goes back to the photo that opened it, and the page behind doesn't scroll.
 * Arrows and a sideways swipe move between photos. In the editor preview the
 * Book button stays inert, like every link there.
 */
export function PhotoViewer({
  ctx,
  photos,
  start,
  examples,
  onClose,
}: {
  ctx: DesignCtx;
  photos: PagePhoto[];
  start: number;
  /** The editor preview's example photos: labeled, and nothing to book. */
  examples: boolean;
  onClose: () => void;
}) {
  const { data, theme, layout, accent, preview } = ctx;
  const count = photos.length;
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), Math.max(count - 1, 0)));
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const go = useCallback((step: number) => setIndex((i) => (i + step + count) % count), [count]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  const photo = photos[index];
  if (!photo) return null;
  const title = photoTitle(data, photo);
  const meta = photoMeta(data, photo);
  const service = serviceOf(data, photo);
  const staff = staffOf(data, photo);
  const tagged = Boolean(service || staff);
  const href = examples ? null : bookPickedHref(ctx, { serviceId: service?.id, staffId: staff?.id });
  const picked = ctx.bookIsNative && tagged ? [service?.name, staff?.name].filter(Boolean).join(" and ") : null;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowRight" && count > 1) {
      go(1);
    } else if (e.key === "ArrowLeft" && count > 1) {
      go(-1);
    } else if (e.key === "Tab") {
      // Keep focus inside while it's open.
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    touchX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    const from = touchX.current;
    touchX.current = null;
    const to = e.changedTouches[0]?.clientX;
    if (from == null || to == null || count < 2) return;
    if (to - from > 40) go(-1);
    else if (from - to > 40) go(1);
  }

  const roundButton = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    color: theme.text,
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={count > 1 ? `Photo ${index + 1} of ${count}` : "Photo"}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="fixed inset-0 z-[210] flex flex-col"
      style={{ backgroundColor: "#060505", color: theme.text, fontFamily: "var(--page-body)" }}
    >
      <div className="flex items-center justify-between p-4">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-11 w-11 place-items-center rounded-full"
          style={roundButton}
        >
          <IconClose />
        </button>
        {count > 1 && (
          <span className="text-sm" style={{ color: theme.muted }} aria-live="polite">
            {index + 1} of {count}
          </span>
        )}
        <span className="h-11 w-11" aria-hidden />
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={title ?? `${data.name} photo ${index + 1}`}
          className="max-h-full max-w-full object-contain"
          style={{ borderRadius: layout.radius }}
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous photo"
              className="absolute left-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full"
              style={roundButton}
            >
              <IconChevron dir="left" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full"
              style={roundButton}
            >
              <IconChevron dir="right" />
            </button>
          </>
        )}
      </div>

      <div
        className="mx-auto mt-4 w-full max-w-lg px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5"
        style={{
          backgroundColor: theme.surface,
          borderTop: `1px solid ${theme.border}`,
          borderRadius: `${layout.radius} ${layout.radius} 0 0`,
        }}
      >
        {examples && (
          <p className="mb-2 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
            Example photo — yours will appear here
          </p>
        )}
        {title && (
          <h2 className="text-2xl leading-tight" style={{ fontFamily: "var(--page-display)" }}>
            {title}
          </h2>
        )}
        {meta && (
          <p className="mt-1.5 text-sm" style={{ color: theme.muted }}>
            {meta}
          </p>
        )}
        {href && (
          <a
            href={preview ? undefined : href}
            onClick={preview ? (e) => e.preventDefault() : undefined}
            className="mt-4 block w-full py-3.5 text-center text-sm font-semibold"
            style={{
              backgroundColor: accent,
              color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
              borderRadius: layout.buttonRadius,
            }}
          >
            {tagged ? "Book this look" : "Book an appointment"}
          </a>
        )}
        {href && picked && (
          <p className="mt-2 text-center text-xs" style={{ color: theme.muted }}>
            Opens booking with {picked} already picked.
          </p>
        )}
      </div>
    </div>
  );
}

function IconClose() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconChevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
