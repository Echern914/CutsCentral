"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { joinWaitlistAction } from "./actions";

/**
 * Public "Join the waitlist" form on the shop page. Theme-driven to match the
 * page (mirrors RequestForm). Collapsed to a button by default; expands on tap.
 * Standing / any-time join (no specific slot) - the barber reaches out when a
 * spot opens. Requires a phone or email so they can be reached.
 */
export function ShopWaitlistForm({
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
  preview?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const fieldStyle: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    color: "inherit",
    borderRadius: theme.radius,
  };
  const inputStyle: CSSProperties = { ...fieldStyle, borderRadius: `min(${theme.radius}, 0.75rem)` };

  function submit() {
    if (preview) return;
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
      <div className="p-4 text-center" style={fieldStyle}>
        <p className="text-sm font-semibold">You&apos;re on the waitlist ✓</p>
        <p className="mt-1 text-xs" style={{ color: theme.muted }}>
          {shopName} will reach out if a spot opens.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => (preview ? undefined : setOpen(true))}
        className="block w-full py-3 text-center text-sm font-medium"
        style={{ border: `1px solid ${theme.border}`, color: theme.muted, borderRadius: theme.buttonRadius }}
      >
        Join the waitlist
      </button>
    );
  }

  return (
    <div className="p-5" style={fieldStyle}>
      <p className="text-sm font-semibold">Join the waitlist</p>
      <p className="mt-1 text-xs" style={{ color: theme.muted }}>
        Leave your details and {shopName} will reach out if a spot opens up.
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
          {pending ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
    </div>
  );
}
