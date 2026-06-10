import { cn } from "@/lib/cn";

/**
 * Elevated glass surface: translucent charcoal + blur, 1px border, top sheen.
 * `hover` adds a lift + gold-tinted border for interactive grids.
 */
export function Card({
  className,
  hover = false,
  children,
}: {
  className?: string;
  hover?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "glass rounded-2xl",
        hover &&
          "transition-all duration-300 hover:-translate-y-0.5 hover:border-gold/25 hover:shadow-glow-sm",
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
