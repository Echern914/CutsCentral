"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { confirmAdminTotpAction, startAdminTotpSetupAction } from "./actions";

/**
 * Set up (or redo) the authenticator app for admin sign-in. Shown once the
 * admin has passed the second step - the API refuses setup without a pass, so
 * a stolen session can never enroll its own authenticator.
 */
export function AdminAuthenticatorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function guarded(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const start = () =>
    guarded(async () => {
      const res = await startAdminTotpSetupAction();
      if (!res.ok || !res.secret || !res.qr) {
        setError("Couldn't start setup. Try again.");
        return;
      }
      setSetup({ secret: res.secret, qr: res.qr });
      setCode("");
    });
  const confirm = () =>
    guarded(async () => {
      const res = await confirmAdminTotpAction(code.trim());
      if (!res.ok) {
        setError("That code didn't match. Check the app shows ChairBack admin and try the newest code.");
        return;
      }
      setSetup(null);
      setDone(true);
      router.refresh();
    });

  return (
    <section aria-labelledby="two-step-heading" className="mb-8">
      <Card className="p-4">
        <h2 id="two-step-heading" className="font-display text-base">
          Authenticator app
        </h2>
        {!setup && (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {enabled || done
                ? "On. Admin asks for a code from your app; an emailed code still works if you don't have your phone."
                : "Not set up. Admin is asking for an emailed code each time. An app is stronger and works even if email is down."}
            </p>
            <Button type="button" variant={enabled || done ? "ghost" : "primary"} disabled={busy} onClick={() => void start()}>
              {enabled || done ? "Set up again" : "Set up"}
            </Button>
          </div>
        )}
        {setup && (
          <div className="mt-3 flex flex-col gap-3">
            <ol className="list-decimal pl-5 text-sm text-muted">
              <li>Open Authy (or Google Authenticator, 1Password, any authenticator app).</li>
              <li>Tap Add account and scan this code, or enter the key below.</li>
              <li>Enter the 6-digit code it shows for ChairBack admin.</li>
            </ol>
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made on the server */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} className="rounded-lg bg-white p-2" />
            <p className="break-all font-mono text-xs text-muted" aria-label="Setup key">
              {setup.secret}
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Code from your app"
              placeholder="000000"
              className="w-40 rounded-xl border border-subtle bg-charcoal-900 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-offwhite focus-visible:border-gold/60"
            />
            {error && (
              <p role="alert" className="text-sm text-danger-soft">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="button" disabled={busy || code.length !== 6} onClick={() => void confirm()}>
                Turn on
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {!setup && error && (
          <p role="alert" className="mt-2 text-sm text-danger-soft">
            {error}
          </p>
        )}
      </Card>
    </section>
  );
}
