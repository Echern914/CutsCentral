"use client";

import { useState, useTransition } from "react";
import { checkoutAction, portalAction } from "./actions";

export function UpgradeButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await checkoutAction();
            if (r?.error) setError(r.error);
          })
        }
        className="rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
      >
        {pending ? "Opening checkout…" : label}
      </button>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}

export function ManageBillingButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await portalAction();
            if (r?.error) setError(r.error);
          })
        }
        className="rounded-full border border-subtle px-5 py-2.5 text-sm text-offwhite transition-colors hover:bg-charcoal-700 disabled:opacity-50"
      >
        {pending ? "Opening…" : "Manage billing"}
      </button>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}
