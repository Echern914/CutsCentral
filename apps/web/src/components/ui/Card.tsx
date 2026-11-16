import { cn } from "@/lib/cn";

/**
 * A surface: solid white (charcoal on dark), 1px line, 14px corners.
 * `hover` firms up the line for interactive grids - no lift, no glow.
 */
export function Card({
  id,
  className,
  hover = false,
  children,
}: {
  /** Anchor for a deep link - the feature registry points "#tips" at a card. */
  id?: string;
  className?: string;
  hover?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "glass rounded-2xl",
        hover &&
          "transition-colors duration-150 ease-out hover:border-subtle-strong",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Standard card header band: title + optional subtitle/action, hairline below. */
export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-4">
      <div>
        <h2 className="font-display text-lg">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
