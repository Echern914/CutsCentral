import { setupBrief } from "@chairback/config/onboarding";
import { HelpSeatSync } from "@/components/help/helpSeat";
import { getOnboardingState } from "./state";

/**
 * Onboarding group layout. Exists to give the client-component onboarding page
 * a distinct document title (WCAG 2.4.2) — "use client" pages can't export
 * metadata themselves. The connect/done steps override with their own titles.
 */
export const metadata = { title: "Set up your shop" };

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // Asked mid-setup, the corner Assistant answers from where this shop is.
  // No shop yet (the first step) or not the owner: null, and it answers as
  // before. Memoized per request with the step page's own read (lib/me.ts).
  const state = await getOnboardingState();
  return (
    <>
      {children}
      <HelpSeatSync role="OWNER" setup={state ? setupBrief(state.facts) : null} />
    </>
  );
}
