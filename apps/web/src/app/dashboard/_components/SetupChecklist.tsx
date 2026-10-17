import Link from "next/link";
import {
  ONBOARDING_PATH,
  ONBOARDING_STEP_LABEL,
  nextOnboardingStep,
  onboardingPlan,
  onboardingStepDone,
  type OnboardingStepId,
} from "@chairback/config/onboarding";
import type { OnboardingState } from "@/app/onboarding/state";

// The same names the Assistant uses for these steps (config/onboarding.ts).
const LABEL: Partial<Record<OnboardingStepId, string>> = ONBOARDING_STEP_LABEL;

/**
 * THE ONE SETUP CHECKLIST, on the dashboard until clients can book the shop.
 * The same steps, in the same order, read from the same facts as setup itself
 * (config/onboarding.ts) - so it can never disagree with setup about what is
 * done, the way the old Getting Started card (calendar / clients / rewards)
 * disagreed with the go-live checks. Each step opens its setup screen.
 */
export function SetupChecklist({ state }: { state: OnboardingState }) {
  const steps = onboardingPlan(state.facts).filter((s) => LABEL[s]);
  const required = steps.filter((s) => s !== "clients");
  const doneCount = required.filter((s) => onboardingStepDone(s, state.facts)).length;
  const next = nextOnboardingStep(state.facts);

  return (
    <section
      aria-labelledby="setup-checklist-title"
      className="mb-6 rounded-2xl border border-gold/40 bg-gold/5 p-5"
      data-testid="setup-checklist"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="setup-checklist-title" className="font-display text-xl tracking-tight">
          Finish setting up
        </h2>
        <p className="text-xs text-muted">
          {doneCount} of {required.length} done
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">Clients can book you once these are done.</p>
      <ol className="mt-4 flex flex-col gap-2">
        {steps.map((s) => {
          const done = onboardingStepDone(s, state.facts);
          return (
            <li key={s}>
              {done ? (
                <span className="flex items-center gap-3 rounded-xl border border-subtle px-4 py-3 text-sm text-muted">
                  <span aria-hidden="true" className="text-emerald-soft">
                    ✓
                  </span>
                  <span className="line-through decoration-muted/50">{LABEL[s]}</span>
                  <span className="sr-only">(done)</span>
                </span>
              ) : (
                <Link
                  href={ONBOARDING_PATH[s]}
                  className="flex items-center gap-3 rounded-xl border border-subtle px-4 py-3 text-sm text-offwhite transition-colors hover:border-gold/50"
                >
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full border border-muted" />
                  <span className="min-w-0 flex-1">
                    {LABEL[s]}
                    {s === "clients" && <span className="text-muted"> (optional)</span>}
                  </span>
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>
      {next !== "done" && next !== "clients" && (
        <Link
          href={ONBOARDING_PATH[next]}
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted sm:w-auto"
        >
          Continue setup
        </Link>
      )}
    </section>
  );
}
