"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { TOURS, type TourId } from "./tourPaths";
import { readTourStep, useDemoTour, writeTourStep } from "./state";

/**
 * The guided client-experience tour: a spotlight + callout bubble walked across
 * the demo shop's REAL pages. Each demo-tenant page mounts <DemoTour route> and
 * the overlay renders only while a tour is running (sessionStorage, bootstrapped
 * by a ?tour=N link, e.g. from /demo).
 *
 * Deliberately non-blocking: the dim layer never intercepts clicks, so the page
 * under the tour stays fully interactive (toggling add-ons, tapping "On my
 * way" — the demo's whole point is that it's alive). If the viewer wanders to a
 * different tour page mid-step, the overlay re-syncs to that page's first step.
 *
 * ChairBack-branded dark chrome on purpose — the bubble is the product talking,
 * distinct from the shop-themed page behind it. Portaled to <body>: the client
 * pages animate ancestors with framer-motion transforms, which would otherwise
 * re-anchor position:fixed to the transformed ancestor.
 */
export function DemoTour({
  route,
  tour = "client",
  prospect = false,
}: {
  route: string;
  /** Which tour this page belongs to (registry id — serializable from RSC). */
  tour?: TourId;
  /**
   * Anonymous prospect on the read-only demo session: the finish button
   * becomes the signup CTA (spec.prospectFinish*). Only the page hosting the
   * LAST step needs to pass this — the finish button renders nowhere else.
   */
  prospect?: boolean;
}) {
  const router = useRouter();
  const spec = TOURS[tour];
  const { step } = useDemoTour(tour);
  const [mounted, setMounted] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const lastScrolledStep = useRef<number | null>(null);

  useEffect(() => setMounted(true), []);

  // Bootstrap from a ?tour=N link (the /demo entries, feature-search deep
  // links, or a shared mid-tour URL). Which TOUR the number belongs to is
  // decided by the page that mounts this component, so ?tour=N is unambiguous.
  // Query beats storage so a deep link always lands on its step. Read once on
  // mount — client-side step changes own the URL after.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("tour");
    if (raw === null) return;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= spec.steps.length && n !== readTourStep(tour)) {
      writeTourStep(tour, n);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = step === null ? null : spec.steps[step - 1] ?? null;

  // If the running step belongs to another page (viewer clicked a real link
  // mid-tour), follow them: jump to this page's first step.
  useEffect(() => {
    if (!active || active.route === route) return;
    const first = spec.steps.findIndex((s) => s.route === route);
    if (first !== -1) writeTourStep(tour, first + 1);
  }, [active, route, spec, tour]);

  // Track the anchor's rect every frame while the tour runs. The client pages
  // stagger-animate sections into place (springs, not fixed durations), so a
  // one-shot measurement goes stale; a rAF loop is simple and always right.
  useEffect(() => {
    if (!active || active.route !== route) {
      setRect(null);
      return;
    }
    let raf = 0;
    const track = () => {
      const el = document.querySelector(`[data-tour="${active.anchor}"]`);
      if (!el) {
        setRect(null);
      } else {
        const r = el.getBoundingClientRect();
        setRect((cur) =>
          cur &&
          Math.abs(cur.top - r.top) < 0.5 &&
          Math.abs(cur.left - r.left) < 0.5 &&
          Math.abs(cur.width - r.width) < 0.5 &&
          Math.abs(cur.height - r.height) < 0.5
            ? cur
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
        if (lastScrolledStep.current !== step) {
          lastScrolledStep.current = step;
          const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
        }
      }
      raf = window.requestAnimationFrame(track);
    };
    raf = window.requestAnimationFrame(track);
    return () => window.cancelAnimationFrame(raf);
  }, [active, route, step]);

  const go = useCallback(
    (n: number) => {
      const target = spec.steps[n - 1];
      if (!target) return;
      writeTourStep(tour, n);
      if (target.route !== route) {
        router.push(`${spec.pathFor(target.route)}?tour=${n}`);
      }
    },
    [route, router, spec, tour],
  );

  const end = useCallback(() => {
    writeTourStep(tour, null);
    // Strip ?tour so a reload doesn't resurrect the tour from the URL.
    if (window.location.search.includes("tour=")) {
      router.replace(window.location.pathname);
    }
  }, [router, tour]);

  const finish = useCallback(() => {
    writeTourStep(tour, null);
    router.push(
      prospect ? (spec.prospectFinishHref ?? spec.finishHref) : spec.finishHref,
    );
  }, [prospect, router, spec, tour]);

  if (!mounted || step === null || !active || active.route !== route) return null;

  const isFirst = step === 1;
  const isLast = step === spec.steps.length;
  const pad = 6;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[120]" aria-live="polite">
      {/* Spotlight: a cutout box whose massive shadow dims everything else.
          Falls back to a plain dim when the anchor is missing — never a blank
          screen, the bubble still explains the step. */}
      {rect ? (
        <div
          className="fixed transition-all duration-200 ease-out"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            borderRadius: 14,
            boxShadow: "0 0 0 9999px rgba(6,6,10,0.62)",
            border: "1.5px solid rgba(255,255,255,0.4)",
          }}
          aria-hidden
        />
      ) : (
        <div className="fixed inset-0 bg-[#06060A]/50" aria-hidden />
      )}

      {/* Callout bubble: below the spotlight when it fits, above otherwise;
          bottom sheet on small screens. key={step} re-runs the entrance. */}
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="pointer-events-auto fixed inset-x-3 bottom-3 mx-auto max-w-sm rounded-2xl border border-white/15 bg-[#101014]/95 p-4 text-offwhite shadow-2xl backdrop-blur sm:inset-x-auto"
        style={bubblePosition(rect, pad)}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
            {spec.label} · {step} of {spec.steps.length}
          </p>
          <button
            type="button"
            onClick={end}
            className="text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite"
          >
            End tour
          </button>
        </div>
        <h2 className="mt-2 font-display text-lg leading-snug">{active.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{active.body}</p>
        <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div
            className="h-full rounded-full bg-gold transition-all duration-200 ease-out"
            style={{ width: `${(step / spec.steps.length) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          {!isFirst && (
            <button
              type="button"
              onClick={() => go(step - 1)}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? finish() : go(step + 1))}
            className="flex-1 rounded-xl bg-offwhite py-2 text-center text-sm font-semibold text-black transition-transform duration-200 ease-out hover:scale-[1.01]"
          >
            {isLast
              ? prospect
                ? (spec.prospectFinishLabel ?? spec.finishLabel)
                : spec.finishLabel
              : "Next"}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

/**
 * Desktop bubble placement: under the spotlight when there's room, else above
 * it, clamped to the viewport; small screens keep the bottom-sheet classes
 * (this only applies from sm: up, where inset-x-auto releases the sheet).
 */
function bubblePosition(
  rect: { top: number; left: number; width: number; height: number } | null,
  pad: number,
): React.CSSProperties {
  if (typeof window === "undefined" || window.innerWidth < 640) return {};
  const width = 384; // max-w-sm
  if (!rect) {
    // No anchor yet (or a missing one): center the bubble instead of letting
    // the mobile bottom-sheet classes strand it at the viewport edge.
    return { top: "40%", left: window.innerWidth / 2 - width / 2, bottom: "auto" };
  }
  const below = rect.top + rect.height + pad + 12;
  const fitsBelow = below + 220 < window.innerHeight;
  const top = fitsBelow ? below : Math.max(12, rect.top - pad - 12 - 220);
  const left = Math.min(
    Math.max(12, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 12,
  );
  return { top, left, bottom: "auto" };
}
