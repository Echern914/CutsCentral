"use client";

import { useState, useTransition } from "react";
import { enableReceptionistAction } from "./actions";

/**
 * Minimal enable/disable controls for the AI receptionist, shown once the shop
 * is entitled (Premium AI tier, the $40 add-on, or a comped pilot). The first
 * enable requires the liability acknowledgment - the API rejects it otherwise
 * (400 receptionist_terms_required) - and the acceptance is one-time: once
 * stamped, the checkbox never shows again.
 */
export function ReceptionistControls({
  enabled,
  termsAccepted,
  bookingMode,
}: {
  enabled: boolean;
  termsAccepted: boolean;
  bookingMode: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const needsTerms = !termsAccepted && !enabled;
  const nativeReady = bookingMode === "native";

  return (
    <div className="mt-5 rounded-2xl border border-subtle bg-charcoal-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-offwhite">AI receptionist</p>
          <p className="mt-0.5 text-xs text-muted">
            {enabled
              ? "On - answering client texts, booking and rescheduling 24/7."
              : "Off - client texts get no AI reply until you turn it on."}
          </p>
        </div>
        <button
          disabled={pending || (needsTerms && !acknowledged)}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await enableReceptionistAction({
                enable: !enabled,
                acceptTerms: needsTerms && acknowledged,
              });
              if (r?.error) setError(r.error);
            })
          }
          className={
            enabled
              ? "rounded-full border border-subtle px-5 py-2 text-sm text-offwhite transition-all duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
              : "rounded-full bg-gold-gradient px-5 py-2 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
          }
        >
          {pending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {needsTerms && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-subtle bg-charcoal-900/60 px-4 py-3 text-xs text-muted">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#D4AF37]"
          />
          <span>
            I understand the AI receptionist can make scheduling mistakes
            (double-bookings, missed or incorrect bookings), that I&apos;m
            responsible for reviewing my calendar, and that ChairBack isn&apos;t
            liable for scheduling errors. See the{" "}
            <a href="/terms" className="text-gold underline-offset-2 hover:underline">
              Terms
            </a>
            .
          </span>
        </label>
      )}

      {!nativeReady && (
        <p className="mt-3 text-xs text-muted">
          Heads up: the receptionist books on your ChairBack booking page. Switch
          booking to <span className="text-offwhite">ChairBack Booking</span> in
          Settings for it to take appointments.
        </p>
      )}

      {error && <p className="mt-3 text-xs text-danger-soft">{error}</p>}
    </div>
  );
}
