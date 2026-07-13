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
    case "nudges":
      return "/dashboard/nudges";
    case "site":
      return "/dashboard/site";
    case "payments":
      return "/dashboard/payments";
    case "insights":
      return "/dashboard/insights";
    case "billing":
      return "/dashboard/billing";
  }
}

/**
 * The two guided tours, keyed by id (components pass the id — a plain string —
 * across the server/client boundary; the spec itself holds functions).
 *  - client: the demo shop's public pages (what a barber's CUSTOMERS get).
 *  - dashboard: the barber side — every new barber's interactive first-run
 *    walk of their OWN dashboard (auto-armed on first visit, replayable from
 *    the Overview header), and what prospects explore through a read-only
 *    demo session (/demo/dashboard). Barbers finish back home; prospects get
 *    the signup CTA instead (the last-step page passes `prospect` to
 *    DemoTour).
 */
export type TourId = "client" | "dashboard";

export interface TourSpec {
  id: TourId;
  steps: DemoTourStep[];
  /** sessionStorage key holding the 1-based step (distinct per tour). */
  storageKey: string;
  /** Eyebrow label on the callout bubble ("<label> · 3 of 12"). */
  label: string;
  pathFor(route: string): string;
  finishLabel: string;
  finishHref: string;
  /** Finish overrides for anonymous prospects on the read-only demo session. */
  prospectFinishLabel?: string;
  prospectFinishHref?: string;
}

export const TOURS: Record<TourId, TourSpec> = {
  client: {
    id: "client",
    steps: DEMO_TOUR_STEPS,
    storageKey: "cb_demo_tour",
    label: "Live demo",
    pathFor: (route) => pathForTourRoute(route as ClientTourRoute),
    finishLabel: "Finish",
    finishHref: "/dashboard",
  },
  dashboard: {
    id: "dashboard",
    steps: DASHBOARD_TOUR_STEPS,
    storageKey: "cb_dash_tour",
    label: "Dashboard tour",
    pathFor: (route) => pathForDashboardTourRoute(route as DashboardTourRoute),
    finishLabel: "Done — it's all yours",
    finishHref: "/dashboard",
    prospectFinishLabel: "Create your shop →",
    prospectFinishHref: "/signup",
  },
};
