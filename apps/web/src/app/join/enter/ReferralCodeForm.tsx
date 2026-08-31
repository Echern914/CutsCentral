"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { submitReferralCodeAction } from "./actions";

// Keep the global :focus-visible ring (WCAG 2.4.7): no `outline-none`, and the
// border tint supplements that ring rather than replacing it.
const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Checking…" : "Continue"}
    </button>
  );
}

export function ReferralCodeForm() {
  const [state, action] = useFormState(submitReferralCodeAction, {});
  return (
    <Card className="px-5 py-6">
      <form action={action} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="code" className="text-sm font-medium text-offwhite">
            Referral code
          </label>
          <input
            id="code"
            name="code"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. 7Kq2mB4xR9tW"
            className={`${field} font-mono`}
            aria-describedby="code-hint"
          />
          <p id="code-hint" className="text-xs text-muted">
            Codes are case-sensitive. You&rsquo;ll find it in the message or post
            that sent you here.
          </p>
        </div>
        {state.error ? <FormError>{state.error}</FormError> : null}
        <Submit />
      </form>
    </Card>
  );
}
