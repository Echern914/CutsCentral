import { ONBOARDING_PATH } from "@chairback/config/onboarding";
import { StepFrame } from "../StepFrame";
import { stepState } from "../state";
import { ClientsStep } from "./ClientsStep";

export const metadata = { title: "Bring your clients" };

/** Setup: the client list (optional). The last step before the finish. */
export default async function ClientsStepPage() {
  const state = await stepState();
  return (
    <StepFrame
      step="clients"
      state={state}
      title="Bring your clients"
      lead="Import your list from your old app or your phone. Nobody is texted until they opt in themselves."
    >
      <ClientsStep next={ONBOARDING_PATH.done} imported={state.facts.clientCount} />
    </StepFrame>
  );
}
