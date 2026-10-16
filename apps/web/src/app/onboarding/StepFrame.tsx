import type { ReactNode } from "react";
import { stepPosition, type OnboardingStepId } from "@chairback/config/onboarding";
import type { OnboardingState } from "./state";
import { skipSetupAction } from "./stepActions";

/**
 * One setup step: where they are ("Step 3 of 6"), what this step is for, the
 * step itself, and always a way out - "Skip setup for now" goes to the
 * dashboard, which keeps the rest as a checklist.
 */
export function StepFrame({
  step,
  state,
  title,
  lead,
  children,
}: {
  step: OnboardingStepId;
  state: OnboardingState;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  const { at, of } = stepPosition(step, state.facts);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 py-10">
      <p className="text-center text-xs uppercase tracking-[0.2em] text-muted" data-testid="step-position">
        Step {at} of {of}
      </p>
      <h1 className="mb-2 mt-2 text-balance text-center font-display text-3xl tracking-tight">{title}</h1>
      {lead && <p className="mb-6 text-center text-sm text-muted">{lead}</p>}
      {children}
      <form action={skipSetupAction} className="mt-8 text-center">
        <button type="submit" className="text-xs text-muted underline-offset-4 hover:text-offwhite hover:underline">
          Skip setup for now
        </button>
      </form>
    </main>
  );
}
