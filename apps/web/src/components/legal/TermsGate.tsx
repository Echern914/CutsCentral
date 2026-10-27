"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { logoutAction } from "@/app/(auth)/actions";
import { TermsAgreement } from "./TermsAgreement";
import { acceptTermsAction } from "./termsActions";

/**
 * "Before you continue": the whole page, in place of the dashboard, for a
 * signed-in person with no current Terms + Privacy agreement on record -
 * an account made with Google or Apple, an invited team member, and everyone
 * from before the agreement was recorded (once, for the current revision).
 *
 * RENDERED by the dashboard and onboarding layouts as JSX, never called from
 * them (a server file calling a client module's function took every dashboard
 * down on 2026-08-31). The layout only renders this on a definite "required"
 * from the API; when that read fails, the dashboard shows as normal.
 *
 * `previouslyAgreed`: they agreed to an older revision, so the copy says the
 * Terms changed rather than greeting them as if new.
 */
export function TermsGate({ previouslyAgreed }: { previouslyAgreed: boolean }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A second tap while the first is in flight does nothing. A ref, not the
  // busy state alone: state lands a render later than a fast double tap.
  const inFlight = useRef(false);

  async function agree() {
    if (!checked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const res = await acceptTermsAction();
      if (!res.ok) {
        setFailed(true);
        return;
      }
      // Re-render the layout: the API now says not required, so the
      // dashboard renders in place of this screen.
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <p className="mb-4 text-center text-xs uppercase tracking-[0.25em] text-gold">{APP_NAME}</p>
      <Card className="p-6">
        <h1 className="font-display text-2xl tracking-tight">Before you continue</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {previouslyAgreed
            ? `We've updated our Terms of Service and Privacy Policy. Please read them and agree to keep using ${APP_NAME}.`
            : `Please read and agree to our Terms of Service and Privacy Policy to use ${APP_NAME}.`}
        </p>
        <div className="mt-4">
          <TermsAgreement checked={checked} onChange={setChecked} audience="business" id="terms-gate-agree" />
        </div>
        <FormError className="mt-3 text-sm">
          {failed ? "We couldn't save that. Check your connection and try again." : undefined}
        </FormError>
        <button
          type="button"
          onClick={() => void agree()}
          disabled={!checked || busy}
          className="mt-4 w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-on-gold shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Agree and continue"}
        </button>
      </Card>
      <form action={logoutAction} className="mt-5 text-center">
        <button type="submit" className="text-sm text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-offwhite hover:underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
