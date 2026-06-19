import { Card } from "@/components/ui/Card";

/**
 * Generic dashboard-tab loading skeleton. Every sub-tab gets a `loading.tsx`
 * that renders this so a click shows an instant placeholder (matched to the
 * tab's real header + content shape) instead of hanging on the old page while
 * the server render + API round-trips finish. Widths default to the most
 * common layout; pass `maxW`/`rows` to mirror a specific tab.
 */
export function PageSkeleton({
  maxW = "max-w-5xl",
  titleWidth = "w-48",
  rows = 4,
}: {
  maxW?: string;
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <main className={`mx-auto w-full ${maxW} px-4 py-8 sm:px-5`}>
      <div className="mb-6">
        <div className={`h-9 ${titleWidth} rounded-lg skeleton`} />
        <div className="mt-2 h-4 w-72 max-w-full rounded skeleton" />
      </div>
      <div className="flex flex-col gap-4">
        {Array.from({ length: rows }).map((_, i) => (
          <Card key={i} className="h-20 skeleton" />
        ))}
      </div>
    </main>
  );
}
