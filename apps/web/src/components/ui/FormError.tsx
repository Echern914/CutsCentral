import { cn } from "@/lib/cn";

/**
 * Accessible inline form-error message. Renders nothing when there is no error.
 *
 * Accessibility contract (WCAG 3.3.1 / 4.1.3 / 1.4.1):
 * - role="alert" so screen readers announce the error the moment it appears
 *   after a failed submit (the message is injected via JS, so without a live
 *   region it would be silent).
 * - A leading warning glyph (aria-hidden) provides a NON-COLOR cue, so the error
 *   is not signalled by red text alone.
 * - Pass an `id` and reference it from the offending input via
 *   `aria-describedby={id}` + `aria-invalid`, so AT ties the message to the field.
 */
export function FormError({
  id,
  children,
  className,
}: {
  id?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p
      id={id}
      role="alert"
      className={cn(
        "flex items-start gap-1.5 text-xs text-danger-soft",
        className,
      )}
    >
      <span aria-hidden="true" className="leading-none">
        {/* Non-color cue: a warning triangle so the error reads without color. */}
        ⚠
      </span>
      <span>{children}</span>
    </p>
  );
}
