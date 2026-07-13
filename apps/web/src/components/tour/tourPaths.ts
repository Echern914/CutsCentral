import { DEMO } from "@chairback/config/demo";
import type { DemoTourStep } from "@chairback/config/demoTour";

/**
 * The concrete demo-tenant path for each tour route key. Single source for the
 * DemoTour overlay's cross-page navigation and the /demo entry redirect.
 */
export function pathForTourRoute(route: DemoTourStep["route"]): string {
  switch (route) {
    case "shop":
      return `/s/${DEMO.SHOP_SLUG}`;
    case "book":
      return `/book/${DEMO.SHOP_SLUG}`;
    case "manage":
      return `/book/manage/${DEMO.MANAGE_TOKEN}`;
    case "rewards":
      return `/r/${DEMO.MAGIC_TOKEN}`;
  }
}
