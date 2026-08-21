"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";
import { FormError } from "@/components/ui/FormError";
import { NumberField } from "@/components/ui/NumberField";

/**
 * The two fields every service form is built from: a price and a length.
 *
 * They were hand-assembled at a dozen call sites. Some had a "$" set into the
 * box, some a placeholder reading "Price ($)", some only an aria-label - so the
 * same number was asked for four different ways, and on the forms that relied
 * on a placeholder the unit DISAPPEARED the moment you typed. You were then
 * looking at a box containing "45" with nothing on screen to say whether that
 * was dollars, minutes or something else.
 *
 * Three components, one shell:
 *   MoneyField        - a price. String value ("" = not set / inherit).
 *   MinutesField      - a length. String value ("" = not set / inherit).
 *   MinutesNumberField- a length the parent holds as a NUMBER (wraps
 *                       NumberField, which exists to let a numeric box be
 *                       genuinely empty while you type).
 *
 * Price is string-valued everywhere in this app on purpose: blank is a real
 * state ("no price", "use the base price") that a number cannot express.
 *
 * 🔑 THE UNIT IS CHROME, NEVER CONTENT. The "$" and "min" are rendered by the
 * shell, once, outside the value. A caller therefore MUST NOT put a unit in the
 * label or the placeholder too - that is how you get "Price ($)" sitting next
 * to a "$", i.e. "$$50". The parsers in lib/serviceFields strip a unit back off
 * anything typed or pasted, so the two halves of the rule hold together.
 */

const inputBase =
  "w-full rounded-xl border border-subtle bg-charcoal-700 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/** Room for the "$" on the left. */
const PREFIX_PAD = "pl-7 pr-3";
/** Room for the "min" on the right. */
const SUFFIX_PAD = "pl-3 pr-11";

interface ShellProps {
  /** Always rendered. Pass srOnly to hide it visually on a grid that already
   *  has a column header - the label still exists for screen readers. */
  label: string;
  srOnlyLabel?: boolean;
  /** Explanatory line under the field. */
  hint?: string;
  error?: string | null;
  /** Wrapper class (width, grid placement). */
  className?: string;
}

/**
 * What a CALLER passes. Identical to ShellProps except the label is optional -
 * each field supplies its own sensible default ("Price", "Duration"), which is
 * the whole point of having named components rather than a generic one.
 */
type OuterProps = Omit<ShellProps, "label">;

/**
 * Label above, unit inside, error below. One layout so a price and a length
 * always line up with each other however they are arranged on the page.
 */
function FieldShell({
  label,
  srOnlyLabel,
  hint,
  error,
  className,
  prefix,
  suffix,
  inputId,
  hintId,
  errorId,
  children,
}: ShellProps & {
  prefix?: string;
  suffix?: string;
  inputId: string;
  hintId: string;
  errorId: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={inputId}
        className={cn("block text-xs text-muted", srOnlyLabel && "sr-only")}
      >
        {label}
      </label>
      <div className={cn("relative", !srOnlyLabel && "mt-1")}>
        {prefix && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted"
          >
            {prefix}
          </span>
        )}
        {children}
        {suffix && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted"
          >
            {suffix}
          </span>
        )}
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-[11px] text-muted">
          {hint}
        </p>
      )}
      <FormError id={errorId} className="mt-1">
        {error}
      </FormError>
    </div>
  );
}

/**
 * Build the aria-describedby list. Only ids that are actually rendered may
 * appear, or AT announces a reference to nothing.
 */
function describedBy(hint: string | undefined, error: string | null | undefined, hintId: string, errorId: string) {
  const ids = [hint ? hintId : null, error ? errorId : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

/* ------------------------------------------------------------------ */
/* Price                                                               */
/* ------------------------------------------------------------------ */

export function MoneyField({
  value,
  onChange,
  label = "Price",
  srOnlyLabel,
  hint,
  error,
  className,
  inputClassName,
  placeholder,
  disabled,
  id,
}: OuterProps & {
  value: string;
  onChange: (next: string) => void;
  /** Defaults to "Price". Must NOT contain a "$" - the shell renders it. */
  label?: string;
  inputClassName?: string;
  /** A bare number ("45"), never "$45" - the "$" is already on screen. */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? `money-${auto}`;
  return (
    <FieldShell
      label={label}
      srOnlyLabel={srOnlyLabel}
      hint={hint}
      error={error}
      className={className}
      prefix="$"
      inputId={inputId}
      hintId={`${inputId}-hint`}
      errorId={`${inputId}-error`}
    >
      <input
        id={inputId}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, `${inputId}-hint`, `${inputId}-error`)}
        className={cn(inputBase, PREFIX_PAD, inputClassName)}
      />
    </FieldShell>
  );
}

/* ------------------------------------------------------------------ */
/* Length                                                              */
/* ------------------------------------------------------------------ */

export function MinutesField({
  value,
  onChange,
  label = "Duration",
  srOnlyLabel,
  hint,
  error,
  className,
  inputClassName,
  placeholder,
  disabled,
  min = 0,
  id,
}: OuterProps & {
  value: string;
  onChange: (next: string) => void;
  /** Defaults to "Duration". Must NOT contain "min" - the shell renders it. */
  label?: string;
  inputClassName?: string;
  /** A bare number ("30"), never "30 min". */
  placeholder?: string;
  disabled?: boolean;
  min?: number;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? `minutes-${auto}`;
  return (
    <FieldShell
      label={label}
      srOnlyLabel={srOnlyLabel}
      hint={hint}
      error={error}
      className={className}
      suffix="min"
      inputId={inputId}
      hintId={`${inputId}-hint`}
      errorId={`${inputId}-error`}
    >
      <input
        id={inputId}
        type="number"
        min={min}
        step={1}
        inputMode="numeric"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, `${inputId}-hint`, `${inputId}-error`)}
        className={cn(inputBase, SUFFIX_PAD, inputClassName)}
      />
    </FieldShell>
  );
}

/**
 * The same length field for the forms whose state is a NUMBER.
 *
 * Wraps NumberField rather than reimplementing it: that component is what lets
 * a numeric box be genuinely empty mid-typing instead of snapping back to a
 * stuck "0". The unit and label chrome is identical to MinutesField, so the two
 * are indistinguishable on screen.
 */
export function MinutesNumberField({
  value,
  onChange,
  label = "Duration",
  srOnlyLabel,
  hint,
  error,
  className,
  inputClassName,
  placeholder,
  disabled,
  min = 0,
  max,
  id,
}: OuterProps & {
  value: number;
  onChange: (next: number) => void;
  label?: string;
  inputClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? `minutes-${auto}`;
  return (
    <FieldShell
      label={label}
      srOnlyLabel={srOnlyLabel}
      hint={hint}
      error={error}
      className={className}
      suffix="min"
      inputId={inputId}
      hintId={`${inputId}-hint`}
      errorId={`${inputId}-error`}
    >
      <NumberField
        id={inputId}
        integer
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, `${inputId}-hint`, `${inputId}-error`)}
        className={cn(inputBase, SUFFIX_PAD, inputClassName)}
      />
    </FieldShell>
  );
}
