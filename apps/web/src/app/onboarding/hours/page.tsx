import { ONBOARDING_PATH, stepAfter } from "@chairback/config/onboarding";
import { StepFrame } from "../StepFrame";
import { stepState } from "../state";
import { HoursStep } from "./HoursStep";

export const metadata = { title: "Your hours" };

/** Setup: when each person takes appointments. */
export default async function HoursStepPage() {
  const state = await stepState();
  const next = ONBOARDING_PATH[stepAfter("hours", { ...state.facts, staffWithHours: state.facts.staffCount })];
  return (
    <StepFrame
      step="hours"
      state={state}
      title="When do you work?"
      lead={state.staff.length > 1 ? "Set each person's week. Clients can only book inside these hours." : "Set your week. Clients can only book inside these hours."}
    >
      <HoursStep staff={state.staff} next={next} />
    </StepFrame>
  );
}
