import { redirect } from "next/navigation";
import { DEMO_TOUR_STEPS } from "@chairback/config/demoTour";
import { pathForTourRoute } from "@/components/tour/tourPaths";

/**
 * The guided client-experience tour's front door: getchairback.com/demo.
 * Redirects onto the demo tenant's real pages with the tour armed (?tour=N).
 * `?step=N` (or a step id via `?step=book-slots`) deep-links into the middle —
 * the feature-search palette uses this to jump straight to a feature's step.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const raw = url.searchParams.get("step");
  let step = 1;
  if (raw !== null) {
    const byId = DEMO_TOUR_STEPS.findIndex((s) => s.id === raw) + 1;
    const n = byId > 0 ? byId : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= DEMO_TOUR_STEPS.length) step = n;
  }
  const route = DEMO_TOUR_STEPS[step - 1]!.route;
  redirect(`${pathForTourRoute(route)}?tour=${step}`);
}
