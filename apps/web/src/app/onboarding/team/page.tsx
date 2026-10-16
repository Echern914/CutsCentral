import { ONBOARDING_PATH, stepAfter } from "@chairback/config/onboarding";
import { StepFrame } from "../StepFrame";
import { stepState } from "../state";
import { TeamStep } from "./TeamStep";

export const metadata = { title: "Who takes appointments" };

/** Setup: the chairs clients can book. */
export default async function TeamStepPage() {
  const state = await stepState();
  const next = ONBOARDING_PATH[stepAfter("team", { ...state.facts, staffCount: Math.max(1, state.facts.staffCount) })];
  return (
    <StepFrame
      step="team"
      state={state}
      title="Who takes appointments?"
      lead="Add yourself and anyone else clients can book."
    >
      <TeamStep existing={state.staff} myName={state.me.name} next={next} />
    </StepFrame>
  );
}
