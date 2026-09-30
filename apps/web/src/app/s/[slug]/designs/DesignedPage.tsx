"use client";

import type { PageDesignKey } from "@chairback/config/constants";
import type { DesignCtx } from "./model";
import { FreshDesign } from "./FreshDesign";
import { GridDesign } from "./GridDesign";
import { LookbookDesign } from "./LookbookDesign";
import { ProfileDesign } from "./ProfileDesign";
import { ReelDesign } from "./ReelDesign";

/**
 * Every design but classic. Classic stays inline in ShopPageClient, exactly as
 * it was, so the page every shop already has can't change by accident here.
 */
export function DesignedPage({ design, ctx }: { design: Exclude<PageDesignKey, "classic">; ctx: DesignCtx }) {
  switch (design) {
    case "grid":
      return <GridDesign ctx={ctx} />;
    case "lookbook":
      return <LookbookDesign ctx={ctx} />;
    case "reel":
      return <ReelDesign ctx={ctx} />;
    case "profile":
      return <ProfileDesign ctx={ctx} />;
    case "fresh":
      return <FreshDesign ctx={ctx} />;
  }
}
