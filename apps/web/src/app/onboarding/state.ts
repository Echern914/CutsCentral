import { redirect } from "next/navigation";
import {
  ONBOARDING_PATH,
  nextOnboardingStep,
  stepAfter,
  type OnboardingFacts,
  type OnboardingStepId,
} from "@chairback/config/onboarding";
import { getSetupStateResult } from "@/lib/me";

/** GET /api/onboarding/state (routes/onboarding.ts). */
export interface OnboardingState {
  facts: OnboardingFacts;
  shop: {
    name: string;
    slug: string | null;
    publicPageEnabled: boolean;
    timezone: string;
    industry: string;
    completedAt: string | null;
  };
  integrations: { acuity: boolean; square: boolean };
  me: { name: string };
  staff: { id: string; name: string; hasHours: boolean }[];
  /** Names already on the menu. */
  services: string[];
}

/** Memoized per request (lib/me.ts): the dashboard layout and its page both read it. */
export async function getOnboardingState(): Promise<OnboardingState | null> {
  const res = await getSetupStateResult();
  return res.ok && res.data ? (res.data as OnboardingState) : null;
}

/**
 * A setup step's page loads the state through this: no shop, or not the
 * owner, leaves for the dashboard. A shop that finished or skipped setup can
 * still open a step - the dashboard's setup checklist links to them.
 */
export async function stepState(): Promise<OnboardingState> {
  const state = await getOnboardingState();
  if (!state) redirect("/dashboard");
  return state;
}

/** Where "Continue" goes from this step. */
export function continueHref(step: OnboardingStepId, state: OnboardingState): string {
  return ONBOARDING_PATH[stepAfter(step, state.facts)];
}

/** The first step still to do. */
export function resumeHref(state: OnboardingState): string {
  return ONBOARDING_PATH[nextOnboardingStep(state.facts)];
}
