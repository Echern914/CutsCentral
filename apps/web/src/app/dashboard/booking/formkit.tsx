"use client";

import { cn } from "@/lib/cn";

/**
 * THE BOOKING FORMS' SHARED SKIN — one source of truth for the card treatment,
 * the field scaffold and the input skin that the appointment sheet introduced.
 *
 * These started life inside AppointmentEditForm. The moment a second form
 * (New appointment, Block off time) wanted to look like the sheet, copying the
 * class strings would have meant the next design pass updates one form and
 * quietly strands the others — which is exactly how the booking surface ended
 * up with two visual generations in the first place. Import these; don't
 * re-derive them.
 */

/**
 * 16px floor on inputs — anything smaller makes iOS zoom the whole page.
 * (The globals.css `:where()` floor has zero specificity BY DESIGN, so a
 * `text-sm` utility on an input silently wins and re-introduces the zoom.
 * Using this constant is what keeps that from happening.)
 *
 * `min-w-0` alongside `w-full` so a control with a wide intrinsic size (a
 * native date or time picker, a 60-character email) can never push its
 * container past the card. A long value scrolls INSIDE the input, which is
 * what an input is for; the sheet's width is not negotiable.
 */
export const INPUT =
  "h-11 w-full min-w-0 rounded-lg border border-subtle bg-charcoal-900 px-3 text-base text-offwhite transition-colors duration-150 ease-out placeholder:text-muted/60 focus-visible:border-gold/50";

/**
 * A selectable chip — provider pickers, time slots, repeat toggles. One shape
 * for every "pick one of these" control, 44px tall so it is a real target.
 */
export function chip(selected: boolean, className?: string): string {
  return cn(
    "flex h-11 items-center justify-center rounded-lg border px-3 text-sm transition-colors duration-150 ease-out",
    selected
      ? "border-gold/50 bg-gold/10 text-gold"
      : "border-subtle text-muted hover:text-offwhite",
    className,
  );
}

/** The card every form section rides in — identical to the detail view's Panel. */
export function Group({
  title,
  action,
  children,
}: {
  title: string;
  /** Small control on the header row (e.g. "Custom time", "All day"). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
          {title}
        </h3>
        {action}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * 🔴 `min-w-0` IS THE WHOLE FIX for the overlapping Date/Start class of bug.
 * As a grid item this label defaults to `min-width: auto`, which resolves to
 * the min-content width of the widest control inside it — for a native date
 * input, wider than half a phone. The item then overflows its own
 * `minmax(0,1fr)` track instead of shrinking. Every field carries it, not just
 * the known pairs, so the next two-up grid someone adds inherits the fix.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint && (
        <span className="[overflow-wrap:anywhere] text-[11px] leading-snug text-muted/80">
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * A form's one full-width primary, for a Dialog FOOTER — which is flex-none
 * and never scrolls away, unlike a button that trails a long body. Any error
 * worth blocking on renders directly above it, because an error the barber
 * has to scroll back up to read is an error that goes unread.
 */
export function FormFooter({
  error,
  label,
  pendingLabel,
  pending,
  disabled,
  onSubmit,
  tone = "gold",
}: {
  error: string | null;
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  /** "gold" for booking money-paths; "quiet" keeps Block-off visually distinct. */
  tone?: "gold" | "quiet";
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending || disabled}
        className={cn(
          "flex h-11 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold transition-colors duration-150 ease-out disabled:opacity-50",
          tone === "gold"
            ? "bg-gold text-charcoal-900 hover:bg-gold-muted"
            : "bg-offwhite text-charcoal hover:bg-white",
        )}
      >
        {pending ? pendingLabel : label}
      </button>
    </div>
  );
}
