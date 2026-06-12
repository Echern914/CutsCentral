"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the done page's server data while the Acuity backfill imports
 * history. Replaces a <meta http-equiv=refresh> which kept firing during
 * navigation away from the page and yanked the user back mid-click. This
 * interval dies with the component (navigation unmounts it) and gives up
 * after ~1 minute so a brand-new Acuity account with nothing to import
 * doesn't poll forever.
 */
export function BackfillPoller({ active }: { active: boolean }) {
  const router = useRouter();
  const ticks = useRef(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      ticks.current += 1;
      if (ticks.current > 15) {
        clearInterval(id);
        return;
      }
      router.refresh();
    }, 4000);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
