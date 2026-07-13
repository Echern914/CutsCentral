import { DEMO } from "@chairback/config/demo";
import {
  DASHBOARD_TOUR_STEPS,
  DEMO_TOUR_STEPS,
  type ClientTourRoute,
  type DashboardTourRoute,
  type DemoTourStep,
} from "@chairback/config/demoTour";

/**
 * The concrete path for each tour route key. Single source for the DemoTour
 * overlay's cross-page navigation and the /demo entry redirects.
 */
export function pathForTourRoute(route: ClientTourRoute): string {
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

export function pathForDashboardTourRoute(route: DashboardTourRoute): string {
  switch (route) {
    case "overview":
      return "/dashboard";
    case "agenda":
      return "/dashboard/booking";
    case "clients":
      return "/dashboard/clients";
    case "rewards-manager":
      return "/dashboard/rewards";
    case "insights":
      return "/dashboard/insights";
  }
}

/**
 * The two guided tours, keyed by id (components pass the id — a plain string —
 * across the server/client boundary; the spec itself holds functions).
 *  - client: the demo shop's public pages (what a barber's CUSTOMERS get).
 *  - dashboard: the barber side — prospects explore it through a read-only
 *    demo session (/demo/dashboard); signed-up barbers can replay it on their
 *    own dashboard. Finishes on the signup CTA.
 */
export type TourId = "client" | "dashboard";

export interface TourSpec {
  id: TourId;
  steps: DemoTourStep[];
  /** sessionStorage key holding the 1-based step (distinct per tour). */
  storageKey: string;
  pathFor(route: string): string;
  finishLabel: string;
  finishHref: string;
}

export const TOURS: Record<TourId, TourSpec> = {
  client: {
    id: "client",
    steps: DEMO_TOUR_STEPS,
    storageKey: "cb_demo_tour",
    pathFor: (route) => pathForTourRoute(route as ClientTourRoute),
    finishLabel: "Finish",
    finishHref: "/dashboard",
  },
  dashboard: {
    id: "dashboard",
    steps: DASHBOARD_TOUR_STEPS,
    storageKey: "cb_dash_tour",
    pathFor: (route) => pathForDashboardTourRoute(route as DashboardTourRoute),
    finishLabel: "Create your shop →",
    finishHref: "/signup",
  },
};
