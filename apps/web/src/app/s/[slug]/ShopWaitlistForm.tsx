"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { readableOn } from "@/lib/contrast";
import {
  browserTimezone,
  CONSENT_TEXT,
  EMPTY_ROW,
  HORIZON_DAYS,
  localDate,
  MAX_WINDOWS,
  rowToWindow,
  type Row,
  type WaitlistWindowInput,
} from "@/lib/waitlistRows";
import { joinWaitlistAction } from "./actions";

/**
 * Public "Join the waitlist" form on the shop page. Theme-driven to match the
 * page (mirrors RequestForm). Collapsed to a button by default; expands on tap.
 *
 * Same contract as the booking page's WaitlistForm (shared row logic in
 * lib/waitlistRows): preferences are PICKED as date/time windows rather than
 * typed as free text, the SMS-consent box ships UNCHECKED and is never a
 * condition of joining, and the customer's own timezone rides along so the
 * barber reads "Saturday morning" in the right clock. The old free-text
 * "Preferred time" box is gone - the server still displays it on rows that
 * predate this form, but new joins are matchable windows.
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
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [smsConsent, setSmsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const fieldStyle: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    color: "inherit",
    borderRadius: theme.radius,
  };
  const inputStyle: CSSProperties = { ...fieldStyle, borderRadius: `min(${theme.radius}, 0.75rem)` };
  const chipStyle = (on: boolean): CSSProperties => ({
    border: `1px solid ${on ? accent : theme.border}`,
    backgroundColor: on ? `${accent}22` : "transparent",
    color: on ? "inherit" : theme.muted,
    borderRadius: "9999px",
  });

  function patch(i: number, next: Partial<Row>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
  }

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
    const windows: WaitlistWindowInput[] = [];
    for (const row of rows) {
      const res = rowToWindow(row);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      windows.push(res.window);
    }
    startTransition(async () => {
      const res = await joinWaitlistAction(slug, {
        firstName: firstName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        windows,
        // Best-effort: an older browser just gets the shop's zone server-side.
        timezone: browserTimezone(),
        smsConsent: smsConsent && Boolean(phone.trim()),
      });
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setEmailed(Boolean(email.trim()));
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div role="status" className="p-4 text-center" style={fieldStyle}>
        <p className="text-sm font-semibold">You&apos;re on the waitlist ✓</p>
        <p className="mt-1 text-xs" style={{ color: theme.muted }}>
          {shopName} will reach out if a spot opens up that fits.
        </p>
        {emailed && (
          <p className="mt-2 text-xs" style={{ color: theme.muted }}>
            Check your email &mdash; there&apos;s a link in there to take
            yourself back off the list any time.
          </p>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => (preview ? undefined : setOpen(true))}
        aria-expanded={false}
        className="block w-full py-3 text-center text-sm font-medium"
        style={{ border: `1px solid ${theme.border}`, color: theme.muted, borderRadius: theme.buttonRadius }}
      >
        Join the waitlist
      </button>
    );
  }

  const min = localDate();
  const max = localDate(HORIZON_DAYS);

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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "waitlist-error" : undefined}
          // The form only renders after the "Join the waitlist" tap — move
          // focus into it so keyboard/SR users land on the revealed fields.
          autoFocus
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-70"
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
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-70"
          style={inputStyle}
        />
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional)"
          aria-label="Email"
          className="w-full px-4 py-2.5 text-sm placeholder:opacity-70"
          style={inputStyle}
        />

        {/* ---- when they're free (same rows as the booking page) ---- */}
        <fieldset className="p-3" style={{ border: `1px solid ${theme.border}`, borderRadius: `min(${theme.radius}, 0.75rem)` }}>
          <legend className="px-1 text-xs" style={{ color: theme.muted }}>
            When are you free?
          </legend>
          <div className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <div key={i} className="flex flex-col gap-2">
                {rows.length > 1 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
                      Option {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRows((c) => c.filter((_, j) => j !== i))}
                      className="text-[11px] underline"
                      style={{ color: theme.muted }}
                    >
                      Remove
                    </button>
                  </div>
                )}
                <div
                  role="group"
                  aria-label={`Dates for option ${i + 1}`}
                  className="flex flex-wrap gap-1.5"
                >
                  {(
                    [
                      ["any", "Any date"],
                      ["on", "A date"],
                      ["between", "A range"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={row.dateMode === mode}
                      onClick={() => patch(i, { dateMode: mode })}
                      className="px-3 py-1 text-xs transition-colors"
                      style={chipStyle(row.dateMode === mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {row.dateMode !== "any" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      className="px-4 py-2.5 text-sm sm:w-auto"
                      style={inputStyle}
                      aria-label={
                        row.dateMode === "between"
                          ? `Option ${i + 1} first date`
                          : `Option ${i + 1} date`
                      }
                      min={min}
                      max={max}
                      value={row.startDate}
                      onChange={(e) => patch(i, { startDate: e.target.value })}
                    />
                    {row.dateMode === "between" && (
                      <>
                        <span className="text-xs" style={{ color: theme.muted }}>
                          to
                        </span>
                        <input
                          type="date"
                          className="px-4 py-2.5 text-sm sm:w-auto"
                          style={inputStyle}
                          aria-label={`Option ${i + 1} last date`}
                          min={row.startDate || min}
                          max={max}
                          value={row.endDate}
                          onChange={(e) => patch(i, { endDate: e.target.value })}
                        />
                      </>
                    )}
                  </div>
                )}
                <div
                  role="group"
                  aria-label={`Times for option ${i + 1}`}
                  className="flex flex-wrap gap-1.5"
                >
                  {(
                    [
                      ["any", "Any time"],
                      ["between", "A time range"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={row.timeMode === mode}
                      onClick={() => patch(i, { timeMode: mode })}
                      className="px-3 py-1 text-xs transition-colors"
                      style={chipStyle(row.timeMode === mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {row.timeMode === "between" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      className="px-4 py-2.5 text-sm sm:w-auto"
                      style={inputStyle}
                      aria-label={`Option ${i + 1} start time`}
                      value={row.startTime}
                      onChange={(e) => patch(i, { startTime: e.target.value })}
                    />
                    <span className="text-xs" style={{ color: theme.muted }}>
                      to
                    </span>
                    <input
                      type="time"
                      className="px-4 py-2.5 text-sm sm:w-auto"
                      style={inputStyle}
                      aria-label={`Option ${i + 1} end time`}
                      value={row.endTime}
                      onChange={(e) => patch(i, { endTime: e.target.value })}
                    />
                  </div>
                )}
              </div>
            ))}
            {rows.length < MAX_WINDOWS && (
              <button
                type="button"
                onClick={() => setRows((c) => [...c, { ...EMPTY_ROW }])}
                className="self-start text-xs underline"
                style={{ color: theme.muted }}
              >
                + Add another option
              </button>
            )}
          </div>
        </fieldset>

        {/* ---- consent: unchecked, and never a condition of joining ---- */}
        {phone.trim() && (
          <label className="flex items-start gap-2.5 text-xs" style={{ color: theme.muted }}>
            <input
              type="checkbox"
              checked={smsConsent}
              onChange={(e) => setSmsConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded"
              style={{ accentColor: accent }}
            />
            <span>{CONSENT_TEXT}</span>
          </label>
        )}

        {error && (
          <p id="waitlist-error" role="alert" className="flex items-start gap-1.5 text-xs text-red-500">
            {/* Non-color cue so the error reads without relying on red (WCAG 1.4.1). */}
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          aria-busy={pending}
          className="w-full py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
          style={{
            backgroundColor: accent,
            color: readableOn(accent),
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
