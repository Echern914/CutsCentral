import { cn } from "@/lib/cn";

/** Elevated surface card: rounded-2xl, subtle 1px border, soft ambient shadow. */
export function Card({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-subtle bg-charcoal-800 shadow-ambient",
        className,
      )}
    >
      {children}
    </div>
  );
}
