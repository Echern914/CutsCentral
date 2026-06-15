"use client";

import { pageFontVars } from "@/lib/pageFonts";
import { ShopPageClient } from "@/app/s/[slug]/ShopPageClient";
import type { ShopPageData } from "@/app/s/[slug]/page";

/**
 * Live preview of the public page, rendered from the editor's in-progress state
 * (no save needed) inside a phone frame. Uses the very same ShopPageClient the
 * public route renders, in `preview` mode (links/forms inert), so what the barber
 * sees here is exactly what clients get. The font CSS variables come from the
 * /s layout in production; the editor wrapper re-declares them (pageFontVars) so
 * the preview's typography matches too.
 */
export function LivePreview({ data }: { data: ShopPageData }) {
  return (
    <div className={`mx-auto w-full max-w-[400px] ${pageFontVars}`}>
      <div className="relative rounded-[2.2rem] border-[10px] border-charcoal-600 bg-charcoal-900 shadow-2xl">
        {/* notch */}
        <div className="absolute left-1/2 top-0 z-10 h-5 w-28 -translate-x-1/2 rounded-b-2xl bg-charcoal-600" />
        <div className="h-[640px] overflow-y-auto overscroll-contain rounded-[1.5rem]">
          <ShopPageClient data={data} preview />
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted">
        Live preview · this is exactly what clients see
      </p>
    </div>
  );
}
