import { redirect } from "next/navigation";
import { getOnboardingState, resumeHref } from "../state";

/**
 * Where a web sign-in lands: a shop still setting up goes back to the first
 * thing it is missing; everyone else - a shop that's set up, a team member, a
 * partner, someone with no shop yet - goes to the dashboard as before (which
 * sends someone with no shop on to setup itself).
 *
 * A page, not a route handler: the sign-in form's server action redirects
 * here, and Next follows a page's redirect into the address bar - a route
 * handler's left the bar reading /onboarding/resume over the dashboard.
 *
 * Web sign-in only (password and Google/Apple landings). The app's own
 * sign-in never comes through here, so setup never opens inside the app.
 */
export default async function ResumeSetupPage() {
  const state = await getOnboardingState();
  redirect(state && !state.shop.completedAt ? resumeHref(state) : "/dashboard");
}
