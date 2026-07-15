"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { readableOn } from "@/lib/contrast";
import { submitReviewAction } from "./actions";

/**
 * Public "Leave a review" form on the shop page. Theme-driven to match the page.
 * Rating (1-5 stars) is required; text + name are optional. Submitting lands the
 * review as PENDING - it does NOT appear on the page until the barber approves
 * it, so the confirmation says exactly that (no false "it's live" impression).
 */
export function ReviewForm({
  slug,
  shopName,
  accent,
  theme,
  preview = false,
}: {
  slug: string;
  shopName: string;
  accent: string;
  theme: {
    surface: string;
    border: string;
    muted: string;
    scheme: "light" | "dark";
    radius: string;
    buttonRadius: string;
  };
  /** In-editor preview: never actually submits. */
  preview?: boolean;
}) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const fieldStyle: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    color: "inherit",
    borderRadius: theme.radius,
  };
  const inputStyle: CSSProperties = { ...fieldStyle, borderRadius: `min(${theme.radius}, 0.75rem)` };

  function submit() {
    if (preview) return;
    setError(null);
    if (rating < 1) {
      setError("Please tap a star rating.");
      return;
    }
    startTransition(async () => {
      const res = await submitReviewAction(slug, {
        rating,
        body: body.trim() || undefined,
        authorName: authorName.trim() || undefined,
      });
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div role="status" className="p-5 text-center" style={fieldStyle}>
        <p className="text-sm font-semibold">Thanks for the review ✓</p>
        <p className="mt-1 text-xs" style={{ color: theme.muted }}>
          {shopName} will review it shortly. Once approved it appears here.
        </p>
      </div>
    );
  }

  // The interactive star row: filled up to hover (while hovering) or rating.
  const shown = hover || rating;

  return (
    <div className="p-5" style={fieldStyle}>
      <p className="text-sm font-semibold">Leave a review</p>
      <p className="mt-1 text-xs" style={{ color: theme.muted }}>
        Been to {shopName}? Tell others how it went.
      </p>

      <div
        className="mt-3 flex items-center gap-1"
        role="radiogroup"
        aria-label="Star rating"
        aria-invalid={error && rating < 1 ? true : undefined}
        aria-describedby={error && rating < 1 ? "review-error" : undefined}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-checked={rating === n}
            role="radio"
            // Roving tabindex: only the checked radio is tabbable (or the first
            // when none is selected), so Tab enters/exits the group once and
            // Arrow keys move within it — standard radiogroup keyboard behavior.
            tabIndex={rating === n || (rating === 0 && n === 1) ? 0 : -1}
            onClick={() => setRating(n)}
            onKeyDown={(e) => {
              let next = 0;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                next = Math.min(5, (rating || 0) + 1) || 1;
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                next = Math.max(1, (rating || 1) - 1);
              }
              if (next) {
                e.preventDefault();
                setRating(next);
                // Move focus to follow selection (roving tabindex): grab the nth
                // radio button among this group's siblings.
                const group = e.currentTarget.parentElement;
                const target = group?.children[next - 1] as HTMLElement | undefined;
                target?.focus();
              }
            }}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            className="text-2xl leading-none transition-transform duration-150 ease-out hover:scale-110"
            style={{ color: n <= shown ? accent : theme.border }}
          >
            {/* Filled vs outline glyph: rating readable without color (WCAG 1.4.1). */}
            {n <= shown ? "★" : "☆"}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What stood out? (optional)"
          aria-label="Your review"
          rows={3}
          maxLength={1000}
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-70"
          style={inputStyle}
        />
        <input
          type="text"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          placeholder="Your name (optional)"
          aria-label="Your name"
          maxLength={80}
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-70"
          style={inputStyle}
        />
        {error && (
          <p id="review-error" role="alert" className="flex items-start gap-1.5 text-xs text-red-500">
            {/* Non-color cue so the error reads without relying on red (WCAG 1.4.1). */}
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          aria-busy={pending}
          className="w-full py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
          style={{
            backgroundColor: accent,
            color: readableOn(accent),
            boxShadow: `0 8px 30px -10px ${accent}AA`,
            borderRadius: theme.buttonRadius,
          }}
        >
          {pending ? "Sending…" : "Submit review"}
        </button>
      </div>
    </div>
  );
}
