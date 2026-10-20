"use client";

import { cn } from "@/lib/cn";
import type { LoadFailure } from "@/lib/loadAction";
import { reloadPage } from "@/lib/reloadPage";

/**
 * The line a card shows instead of going blank when its data didn't load.
 *
 * "failed": "Couldn't load <what>. [Try again]" - the retry re-runs the read.
 * "stale": the website was deployed while this page was open, so the page's
 * server actions no longer exist (see lib/loadAction.ts). Retrying can never
 * work; a reload fetches the new build. It is a button the barber presses,
 * never automatic - a reload throws away anything typed into the page.
 *
 * `note` is the reassurance underneath: what is still true even though this
 * card couldn't show it ("Your targeted slots are still live...").
 */
export function LoadFailed({
  what,
  failure,
  onRetry,
  note,
  className,
}: {
  /** Finishes "Couldn't load ___." - e.g. "your targeted slots". */
  what: string;
  failure: LoadFailure;
  onRetry: () => void;
  note?: string;
  className?: string;
}) {
  const stale = failure === "stale";
  return (
    <div role="alert" className={cn("flex flex-col gap-1", className)}>
      <p
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm",
          stale ? "text-offwhite" : "text-danger-soft",
        )}
      >
        <span>{stale ? "ChairBack was updated —" : `Couldn’t load ${what}.`}</span>
        <button
          type="button"
          onClick={() => (stale ? reloadPage() : onRetry())}
          className="rounded-lg border border-offwhite/15 px-3 py-1.5 text-xs font-medium text-offwhite hover:bg-offwhite/5"
        >
          {stale ? "Reload" : "Try again"}
        </button>
      </p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}
