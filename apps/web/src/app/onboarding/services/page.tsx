import { ONBOARDING_PATH, stepAfter } from "@chairback/config/onboarding";
import { BUSINESS_TYPES, type BusinessTypeId } from "@chairback/config/businessTypes";
import { StepFrame } from "../StepFrame";
import { stepState } from "../state";
import { ServicesStep } from "./ServicesStep";

export const metadata = { title: "What you offer" };

/** Setup: the service menu. */
export default async function ServicesStepPage() {
  const state = await stepState();
  const type = BUSINESS_TYPES[state.shop.industry as BusinessTypeId];
  const next = ONBOARDING_PATH[stepAfter("services", { ...state.facts, serviceCount: Math.max(1, state.facts.serviceCount) })];
  return (
    <StepFrame
      step="services"
      state={state}
      title="What do you offer?"
      lead="Bring your menu from your old app, or start from a list. You'll check each one before it's added."
    >
      <ServicesStep existing={state.services} templates={type?.serviceTemplates ?? []} next={next} />
    </StepFrame>
  );
}
