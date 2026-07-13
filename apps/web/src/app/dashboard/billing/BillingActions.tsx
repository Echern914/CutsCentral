"use client";

import { useState, useTransition } from "react";
import {
  cancelAction,
  checkoutAction,
  portalAction,
  receptionistCheckoutAction,
  upgradeAction,
} from "./actions";

export function UpgradeButton({
  label,
  tier = "pro",
  variant = "primary",
}: {
  label: string;
  tier?: "pro" | "pro_ai";
  variant?: "primary" | "secondary";
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await checkoutAction(tier);
            if (r?.error) setError(r.error);
          })
        }
        className={
          variant === "primary"
            ? "rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
            : "rounded-full border border-gold/40 px-6 py-2.5 text-sm font-semibold text-gold transition-all duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
        }
      >
        {pending ? "Opening checkout…" : label}
      </button>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}

/** In-place Premium -> Premium AI upgrade (price swap, prorated today). */
export function UpgradeToPremiumAiButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await upgradeAction();
            if (r?.error) setError(r.error);
          })
        }
        className="rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
      >
        {pending ? "Upgrading…" : label}
      </button>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}

/** Hosted Checkout for the $40/mo receptionist add-on (fallback path when the
 *  Premium AI tier price isn't configured yet). */
export function ReceptionistAddonButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await receptionistCheckoutAction();
            if (r?.error) setError(r.error);
          })
        }
        className="rounded-full border border-gold/40 px-6 py-2.5 text-sm font-semibold text-gold transition-all duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
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
        className="rounded-full border border-subtle px-5 py-2.5 text-sm text-offwhite transition-all duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
      >
        {pending ? "Opening…" : "Manage billing"}
      </button>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}

/**
 * Cancel membership. Understated (destructive, not a headline CTA), with a
 * two-tap confirm before handing off to Stripe's hosted cancel flow. Stripe
 * shows the real "you'll keep access until <date>" details on the next screen,
 * so the in-app confirm just guards against an accidental click.
 */
export function CancelMembershipButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button
          onClick={() => setConfirming(true)}
          className="text-xs text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-danger-soft hover:underline"
        >
          Cancel membership
        </button>
        {error && <p className="text-xs text-danger-soft">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2 rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3">
      <p className="text-sm text-offwhite">Cancel your membership?</p>
      <p className="text-xs text-muted">
        You&apos;ll keep your paid features until the end of the period you&apos;ve
        already paid for, then drop to the Free plan. Your loyalty program, rewards
        page, and client book stay free forever. Stripe will confirm the details on
        the next screen.
      </p>
      <div className="mt-1 flex items-center gap-2">
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await cancelAction();
              if (r?.error) setError(r.error);
            })
          }
          className="rounded-full border border-danger-soft/40 px-4 py-2 text-sm text-danger-soft transition-all duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
        >
          {pending ? "Opening…" : "Yes, cancel"}
        </button>
        <button
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="rounded-full border border-subtle px-4 py-2 text-sm text-offwhite transition-all duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
        >
          Keep my membership
        </button>
      </div>
      {error && <p className="text-xs text-danger-soft">{error}</p>}
    </div>
  );
}
