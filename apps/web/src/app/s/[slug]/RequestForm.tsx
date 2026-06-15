"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { submitRequestAction } from "./actions";

/**
 * Public "Request an appointment" form, shown when the barber has no online
 * booking and has opted into requests. Theme-driven to match the shop page.
 * Requires a phone or email (mirrors the server validation) so the barber can
 * follow up. On success it collapses to a confirmation.
 */
export function RequestForm({
  slug,
  shopName,
  accent,
  theme,
  preview = false,
}: {
  slug: string;
  shopName: string;
  accent: string;
  theme: {
    surface: string;
    border: string;
    muted: string;
    scheme: "light" | "dark";
    radius: string;
    buttonRadius: string;
  };
  /** In-editor preview: never actually submits (keeps editing on the page). */
  preview?: boolean;
}) {
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const fieldStyle: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    color: "inherit",
    borderRadius: theme.radius,
  };
  // Inputs use a slightly tighter radius than the card; never fully pill so text
  // doesn't crowd the rounded edge.
  const inputStyle: CSSProperties = { ...fieldStyle, borderRadius: `min(${theme.radius}, 0.75rem)` };

  function submit() {
    if (preview) return; // editor preview - do nothing
    setError(null);
    if (!firstName.trim()) {
      setError("Please add your name.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so they can reach you back.");
      return;
    }
    startTransition(async () => {
      const res = await submitRequestAction(slug, {
        firstName: firstName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        preferredTime: preferredTime.trim() || undefined,
        message: message.trim() || undefined,
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
      <div className="p-5 text-center" style={fieldStyle}>
        <p className="text-sm font-semibold">Request sent ✓</p>
        <p className="mt-1 text-xs" style={{ color: theme.muted }}>
          {shopName} will reach out to confirm your appointment.
        </p>
      </div>
    );
  }

  return (
    <div className="p-5" style={fieldStyle}>
      <p className="text-sm font-semibold">Request an appointment</p>
      <p className="mt-1 text-xs" style={{ color: theme.muted }}>
        Leave your details and {shopName} will text you back to confirm a time.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <input
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-60 focus:outline-none"
          style={inputStyle}
        />
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Mobile number"
          aria-label="Mobile number"
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-60 focus:outline-none"
          style={inputStyle}
        />
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional)"
          aria-label="Email"
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-60 focus:outline-none"
          style={inputStyle}
        />
        <input
          type="text"
          value={preferredTime}
          onChange={(e) => setPreferredTime(e.target.value)}
          placeholder="Preferred time (e.g. Sat morning)"
          aria-label="Preferred time"
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-60 focus:outline-none"
          style={inputStyle}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Anything else? (optional)"
          aria-label="Message"
          rows={2}
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-60 focus:outline-none"
          style={inputStyle}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="w-full py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
          style={{
            backgroundColor: accent,
            color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
            boxShadow: `0 8px 30px -10px ${accent}AA`,
            borderRadius: theme.buttonRadius,
          }}
        >
          {pending ? "Sending…" : "Send request"}
        </button>
      </div>
    </div>
  );
}
