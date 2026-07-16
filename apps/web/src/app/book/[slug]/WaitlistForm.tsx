"use client";

import { useState, useTransition } from "react";
import { readableOn } from "@/lib/contrast";
import { joinWaitlistAction } from "./actions";

/**
 * "Join the waitlist" form on the booking page. Styled for the booking page's
 * dark chrome (unlike the theme-driven RequestForm on the shop page). serviceId/
 * staffId are passed through when the join comes from a fully-booked day so the
 * barber sees exactly what the customer wants. Collapses to a confirmation.
 */
export function WaitlistForm({
  slug,
  shopName,
  accent,
  serviceId,
  staffId,
  serviceLabel,
  onDone,
}: {
  slug: string;
  shopName: string;
  accent: string;
  serviceId?: string;
  staffId?: string;
  /** e.g. "Mens Haircut with Drick" - shown so they know what they're waiting for. */
  serviceLabel?: string;
  onDone?: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  // No focus:outline-none — keep the global :focus-visible ring (WCAG 2.4.7).
  const input =
    "w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-offwhite placeholder:text-muted focus:border-white/40";

  function submit() {
    setError(null);
    if (!firstName.trim()) {
      setError("Please add your name.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so they can reach you.");
      return;
    }
    startTransition(async () => {
      const res = await joinWaitlistAction(slug, {
        firstName: firstName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        serviceId: serviceId || undefined,
        staffId: staffId || undefined,
        preferredTime: preferredTime.trim() || undefined,
      });
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div role="status" className="rounded-xl border border-white/10 bg-white/5 p-5 text-center">
        <p className="text-sm font-semibold text-offwhite">You're on the waitlist ✓</p>
        <p className="mt-1 text-xs text-muted">
          {shopName} will reach out if a spot opens up.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5">
      <p className="text-sm font-semibold text-offwhite">Join the waitlist</p>
      <p className="mt-1 text-xs text-muted">
        {serviceLabel
          ? `Get notified if a spot opens for ${serviceLabel}.`
          : `Leave your details and ${shopName} will reach out if a spot opens.`}
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <input
          className={input}
          placeholder="Your name"
          aria-label="Your name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          className={input}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="Mobile number"
          aria-label="Mobile number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <input
          className={input}
          type="email"
          autoComplete="email"
          placeholder="Email (optional)"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {/* Only ask for a preferred time on a standing join (no specific slot). */}
        {!serviceId && (
          <input
            className={input}
            placeholder="Preferred time (e.g. Sat morning)"
            aria-label="Preferred time"
            value={preferredTime}
            onChange={(e) => setPreferredTime(e.target.value)}
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              className="rounded-xl border border-white/15 px-4 py-3 text-sm text-muted transition-colors hover:text-offwhite"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            aria-busy={pending}
            className="flex-1 rounded-xl py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
            style={{ backgroundColor: accent, color: readableOn(accent) }}
          >
            {pending ? "Joining…" : "Join the waitlist"}
          </button>
        </div>
      </div>
    </div>
  );
}
