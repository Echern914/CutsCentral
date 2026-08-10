"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A controlled numeric `<input>` that can actually be EMPTY while you type.
 *
 * The bug this exists to kill: a plain `<input type="number" value={n}
 * onChange={e => setN(Number(e.target.value))}>` can never hold an empty string
 * (Number("") is 0), so a field defaulting to 0 shows a stuck "0" you can't
 * delete ("40" becomes "040"), and any field snaps back the moment you clear it.
 *
 * How this fixes it: the parent still owns a NUMBER (`value`/`onChange`), so call
 * sites barely change, but this component keeps an internal STRING draft. While
 * the field is focused you can clear it, type "0.5", etc.; we only push a coerced
 * + clamped number up to the parent as you go, and on blur we normalize the draft
 * back to the committed value (so an empty/garbage field settles to a real
 * number). `min`/`max`/`step` clamp the committed value, not just the spinner.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  integer = false,
  emptyValue,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
  placeholder,
  disabled,
  inputMode,
  blankAtFallback = false,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Round to a whole number when coercing (durations, counts, hours). */
  integer?: boolean;
  /** The number an empty/invalid field commits to (defaults to min ?? 0). */
  emptyValue?: number;
  /**
   * Render the field BLANK (with the fallback shown as grey placeholder text)
   * whenever it holds the fallback value.
   *
   * For a lever that means "no change", a literal typed `0` is actively hostile:
   * tap to the LEFT of it and type 5 and you commit FIFTY, tap to the right and
   * you stare at "05". Drick, verbatim: "have this number not be an actual
   * filled in numeric value... the 0 to be greyed out and as soon as i type a
   * number it changes to just that. Or at least deletable regardless of whether
   * you are in front or behind the number." A placeholder is all three at once
   * - nothing to delete, nothing to type around, and it still reads as zero.
   *
   * Opt-in, because a real setting whose value IS zero (a 0-minute buffer) must
   * keep showing its 0 - there, blank would read as "unset".
   */
  blankAtFallback?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  placeholder?: string;
  disabled?: boolean;
  inputMode?: "numeric" | "decimal";
}) {
  const fallback = emptyValue ?? min ?? 0;
  /** What `value` looks like in the box: blank at the fallback when opted in. */
  const show = (n: number) => (blankAtFallback && n === fallback ? "" : String(n));

  // The visible draft. Seeded from `value`, but decoupled while focused so the
  // field can be empty / mid-typing without the parent forcing a number back in.
  const [draft, setDraft] = useState(() => show(value));
  const focused = useRef(false);

  // Keep the draft in sync with external value changes (e.g. a template/reset or
  // a load) — but never while the user is actively typing in this field.
  useEffect(() => {
    if (!focused.current) setDraft(show(value));
    // `show` closes over blankAtFallback/fallback, both stable per render pass;
    // re-running on `value` is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, blankAtFallback, fallback]);

  /** Coerce a raw string to the clamped number the parent should hold. */
  function coerce(raw: string): number {
    const trimmed = raw.trim();
    if (trimmed === "") return fallback;
    let n = Number(trimmed);
    if (!Number.isFinite(n)) return fallback;
    if (integer) n = Math.round(n);
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return n;
  }

  return (
    <input
      id={id}
      type="number"
      inputMode={inputMode ?? (integer ? "numeric" : "decimal")}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder ?? (blankAtFallback ? String(fallback) : undefined)}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedby}
      aria-invalid={ariaInvalid}
      className={className}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw); // show exactly what they typed (incl. empty)
        // Push the coerced value up as they type so the parent stays current,
        // but keep the raw draft on screen so the field can be blank / partial.
        onChange(coerce(raw));
      }}
      onBlur={() => {
        focused.current = false;
        // Settle the visible field to the committed, clamped number so an empty
        // or out-of-range draft doesn't linger — but under blankAtFallback a
        // committed fallback settles back to BLANK, not to a typed "0", or the
        // stuck zero returns the moment the field loses focus.
        setDraft(show(coerce(draft)));
      }}
    />
  );
}
