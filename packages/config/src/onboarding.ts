/**
 * FIRST-TIME SETUP - which steps a new shop goes through, and which one is next.
 *
 * One path from "I just signed up" to "clients can book me", asked in the
 * order a shop needs it and never asking what is already answered: a step is
 * done when the shop's own data says so (a chair exists, a service exists),
 * not because a screen was visited. So leaving half way and coming back - or
 * doing a step from the dashboard instead - lands on the first thing still
 * missing.
 *
 * Booking on ChairBack needs the whole path (who takes appointments, what
 * they offer, when). A shop that books through Acuity, Square or its own link
 * brings those with it, so its path is shorter.
 *
 * Pure: the API supplies the facts (GET /api/onboarding/state).
 */
import type { BookingModeKey } from "./constants.js";

export type OnboardingStepId = "shop" | "booking" | "team" | "services" | "hours" | "clients" | "done";

export interface OnboardingFacts {
  /** No shop yet: the first step is making one. */
  hasShop: boolean;
  bookingMode: BookingModeKey;
  bookingUrl: string | null;
  /** Acuity or Square is connected - bookings come from there. */
  integrationConnected: boolean;
  /** Active chairs. */
  staffCount: number;
  /** Active services. */
  serviceCount: number;
  /** Active chairs with at least one weekly-hours rule. */
  staffWithHours: number;
  clientCount: number;
}

/** Bookings happen on ChairBack, so it needs chairs, services and hours. */
export function booksOnChairBack(f: OnboardingFacts): boolean {
  return f.bookingMode === "native";
}

/** The shop has said how clients book. A new shop is "link" with no link: not yet. */
export function bookingChosen(f: OnboardingFacts): boolean {
  if (f.bookingMode === "native") return true;
  if (f.integrationConnected) return true;
  return Boolean(f.bookingUrl && f.bookingUrl.trim());
}

/** The steps this shop goes through, in order. */
export function onboardingPlan(f: OnboardingFacts): OnboardingStepId[] {
  if (f.hasShop && bookingChosen(f) && !booksOnChairBack(f)) return ["shop", "booking", "clients", "done"];
  return ["shop", "booking", "team", "services", "hours", "clients", "done"];
}

/** Whether a step is done, read from the shop's own data. `clients` and `done` never are by themselves. */
export function onboardingStepDone(step: OnboardingStepId, f: OnboardingFacts): boolean {
  switch (step) {
    case "shop":
      return f.hasShop;
    case "booking":
      return f.hasShop && bookingChosen(f);
    case "team":
      return f.staffCount > 0;
    case "services":
      return f.serviceCount > 0;
    case "hours":
      return f.staffCount > 0 && f.staffWithHours >= f.staffCount;
    case "clients":
      return f.clientCount > 0;
    case "done":
      return false;
  }
}

/**
 * Clients can book: how they book is chosen, and a shop booking on ChairBack
 * has chairs, services and everyone's hours. Bringing clients is optional. Until
 * this is true the dashboard is a setup checklist with nothing else competing
 * for attention (no trial banner, no go-live bell, no referral card).
 */
export function setupComplete(f: OnboardingFacts): boolean {
  return onboardingPlan(f)
    .filter((s) => s !== "shop" && s !== "clients" && s !== "done")
    .every((s) => onboardingStepDone(s, f));
}

/** The first step still to do. */
export function nextOnboardingStep(f: OnboardingFacts): OnboardingStepId {
  for (const step of onboardingPlan(f)) {
    if (!onboardingStepDone(step, f)) return step;
  }
  return "done";
}

/** The step after this one in the shop's plan (the "Continue" target). */
export function stepAfter(step: OnboardingStepId, f: OnboardingFacts): OnboardingStepId {
  const plan = onboardingPlan(f);
  const at = plan.indexOf(step);
  if (at < 0) return nextOnboardingStep(f);
  // Skip ahead past anything already done (a chair added from the dashboard).
  for (const later of plan.slice(at + 1)) {
    if (!onboardingStepDone(later, f)) return later;
  }
  return "done";
}

/** "Step 3 of 6" - counted over the steps after making the shop. */
export function stepPosition(step: OnboardingStepId, f: OnboardingFacts): { at: number; of: number } {
  const plan: OnboardingStepId[] = onboardingPlan(f).filter((s) => s !== "done");
  const at = plan.indexOf(step);
  return { at: at < 0 ? plan.length : at + 1, of: plan.length };
}

export const ONBOARDING_PATH: Record<OnboardingStepId, string> = {
  shop: "/onboarding",
  booking: "/onboarding/booking",
  team: "/onboarding/team",
  services: "/onboarding/services",
  hours: "/onboarding/hours",
  clients: "/onboarding/clients",
  done: "/onboarding/done",
};
