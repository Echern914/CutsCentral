"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { setOffersEnabledAction } from "./actions";

/**
 * The owner switches Offers & codes on or off for the shop. Off stops every
 * code at once (online and in the shop's own booking form); bookings already
 * made keep the price they were made at. Anyone else is told who can.
 */
export function OffersSwitch({ enabled, canSwitch }: { enabled: boolean; canSwitch: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  // A ref, not just `pending`: a second tap in the same frame must not send twice.
  const busy = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await setOffersEnabledAction(next);
      if (!res.ok) {
        setError(res.error ?? "Couldn't change that. Try again.");
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("No answer from ChairBack. Check your connection, then reload to see whether it changed.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (!enabled) {
    return (
      <section className="rounded-2xl border border-subtle bg-charcoal-800/40 p-5 text-sm" data-testid="offers-off">
        <p className="font-medium text-offwhite">Offers &amp; codes is off for your shop.</p>
        <p className="mt-1 text-muted">
          Switched on, you can make codes anyone can use on your booking page, and offers for one client that you book
          for them. Nothing is sent: you share a code yourself.
        </p>
        {canSwitch ? (
          <button
            type="button"
            onClick={() => void change(true)}
            disabled={pending}
            data-qa="offers-switch-on"
            className="mt-4 rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Switching on…" : "Switch on Offers & codes"}
          </button>
        ) : (
          <p className="mt-3 text-muted">The shop owner can switch it on here.</p>
        )}
        <FormError className="mt-3 text-sm">{error}</FormError>
      </section>
    );
  }

  if (!canSwitch) return null;
  return (
    <section className="mt-10 border-t border-subtle pt-5 text-sm" data-qa="offers-switch">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className="text-muted underline-offset-4 hover:text-offwhite hover:underline"
        >
          Switch off Offers &amp; codes
        </button>
      ) : (
        <div className="space-y-3" data-testid="offers-switch-confirm">
          <p className="text-offwhite">
            Switch off? Every code stops working at once, on your booking page and in your booking form. Bookings
            already made keep their price, and your offers come back as they are if you switch it on again.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void change(false)}
              disabled={pending}
              data-qa="offers-switch-off"
              className="rounded-full border border-subtle px-4 py-1.5 text-danger-soft transition-colors hover:border-danger-soft disabled:opacity-50"
            >
              {pending ? "Switching off…" : "Switch off"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="text-muted hover:text-offwhite"
            >
              Keep it on
            </button>
          </div>
        </div>
      )}
      <FormError className="mt-3 text-sm">{error}</FormError>
    </section>
  );
}
