"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { sendAdminEmailCodeAction, verifyAdminEmailCodeAction, verifyAdminTotpAction } from "./actions";

/**
 * The second step in front of the admin portal (apps/api services/adminStepUp.ts):
 * a code from the authenticator app, or - the fallback - one emailed to the
 * admin's login address. The portal itself never renders until one passes.
 */

const MESSAGES: Record<string, string> = {
  invalid: "That code didn't work. Check it and try again.",
  expired: "That code has expired. Send a new one.",
  too_many_attempts: "Too many tries on that code. Send a new one.",
  too_many: "Too many codes this hour. Try again later.",
  not_set_up: "No authenticator app is set up yet. Use an emailed code.",
  email_unavailable: "Email isn't available right now. Try again in a minute.",
  send_failed: "We couldn't send the email. Try again in a minute.",
};
const say = (error?: string) => MESSAGES[error ?? ""] ?? "Something went wrong. Try again.";

const INPUT =
  "w-full rounded-xl border border-subtle bg-charcoal-900 px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] text-offwhite placeholder:text-muted/50 focus-visible:border-gold/60";

export function AdminTwoStepGate({
  totpEnabled,
  emailAvailable,
  email,
}: {
  totpEnabled: boolean;
  emailAvailable: boolean;
  email: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "email">(totpEnabled ? "totp" : "email");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref, not state: two taps in one tick must not both send.
  const inFlight = useRef(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; sentTo?: string }>, after?: (r: { sentTo?: string }) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(say(res.error));
        return;
      }
      after?.(res);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(sendAdminEmailCodeAction, (r) => {
      setSentTo(r.sentTo ?? email);
      setCode("");
    });
  const verify = () =>
    run(
      () => (mode === "totp" ? verifyAdminTotpAction(code.trim()) : verifyAdminEmailCodeAction(code.trim())),
      () => router.refresh(),
    );

  const waitingForCode = mode === "totp" || sentTo !== null;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm p-6">
        <h1 className="font-display text-xl">Confirm it's you</h1>
        <p className="mt-2 text-sm text-muted">
          {mode === "totp"
            ? "Enter the 6-digit code from your authenticator app (Authy)."
            : sentTo
              ? `We emailed a 6-digit code to ${sentTo}. It works for 10 minutes.`
              : `We'll email a 6-digit code to ${email ?? "your login email"}.`}
        </p>

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (waitingForCode) void verify();
            else void sendCode();
          }}
        >
          {waitingForCode && (
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={mode === "totp" ? "Authenticator code" : "Emailed code"}
              placeholder="000000"
              className={INPUT}
              autoFocus
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-danger-soft">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || (waitingForCode && code.length !== 6)}>
            {busy ? "One moment…" : waitingForCode ? "Continue" : "Email me a code"}
          </Button>
        </form>

        <div className="mt-4 flex flex-col gap-2 text-sm">
          {mode === "totp" && emailAvailable && (
            <button type="button" className="text-left text-muted underline" onClick={() => { setMode("email"); setCode(""); setError(null); }}>
              Don't have your phone? Email me a code instead
            </button>
          )}
          {mode === "email" && sentTo && (
            <button type="button" className="text-left text-muted underline" disabled={busy} onClick={() => void sendCode()}>
              Send a new code
            </button>
          )}
          {mode === "email" && totpEnabled && (
            <button type="button" className="text-left text-muted underline" onClick={() => { setMode("totp"); setCode(""); setError(null); }}>
              Use my authenticator app
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
