"use client";

import { useState, useTransition } from "react";
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
} from "@/lib/waitlistRows";
import {
  joinWaitlistAction,
  type WaitlistWindowInput,
} from "./actions";

// Row logic lives in lib/waitlistRows (shared with the shop page's form so the
// two entry points cannot drift). Re-exported here because this form's tests
// exercise the row contract through this module.
export { rowToWindow };

/**
 * "Join the waitlist" on the booking page.
 *
 * 🔑 PREFERENCES ARE PICKED, NOT TYPED. This used to be one free-text box
 * ("Sat morning") that only a human could read. The matcher has to answer
 * "does this freed 10:15 slot fit anyone", so the customer now picks date and
 * time windows - and the default is still one "Any date / Any time" window,
 * which is exactly what a customer who does not care ends up with and exactly
 * what every pre-existing entry already means.
 *
 * 🔴 THE CONSENT BOX SHIPS UNCHECKED and the join does not depend on it.
 * Pre-ticking it, or refusing the join without it, would make the record
 * worthless as evidence - which is the only reason to collect it.
 *
 * Styled for the booking page's dark chrome (unlike the theme-driven
 * RequestForm on the shop page). Collapses to a confirmation.
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
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [smsConsent, setSmsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [pending, startTransition] = useTransition();

  // No focus:outline-none — keep the global :focus-visible ring (WCAG 2.4.7).
  const input =
    "w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-offwhite placeholder:text-muted focus:border-white/40";
  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      on ? "border-white/50 bg-white/15 text-offwhite" : "border-white/15 text-muted"
    }`;

  function patch(i: number, next: Partial<Row>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
  }

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
        serviceId: serviceId || undefined,
        staffId: staffId || undefined,
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
      <div
        role="status"
        className="rounded-xl border border-white/10 bg-white/5 p-5 text-center"
      >
        <p className="text-sm font-semibold text-offwhite">
          You&rsquo;re on the waitlist &#10003;
        </p>
        <p className="mt-1 text-xs text-muted">
          {shopName} will reach out if a spot opens up that fits.
        </p>
        {emailed ? (
          <p className="mt-2 text-xs text-muted">
            Check your email &mdash; there&rsquo;s a link in there to take
            yourself back off the list any time.
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            You joined by phone, so {shopName} will reach out personally when
            something opens &mdash; automatic opening alerts go out by email
            until texting is available.
          </p>
        )}
      </div>
    );
  }

  const min = localDate();
  const max = localDate(HORIZON_DAYS);

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
        {/* 🔴 Honest channels: customer texting is off until carrier approval,
            so automatic opening offers travel by email (+ app push for known
            clients). A phone-only joiner must be TOLD they're on the manual
            path, not left assuming a text is coming. */}
        {phone.trim() !== "" && email.trim() === "" && (
          <p className="text-xs text-muted">
            Heads up: automatic offers for open spots go out by <b>email</b>{" "}
            until texting is available — with just a phone number,{" "}
            {shopName} will reach out personally instead.
          </p>
        )}

        {/* ---- when they're free ---- */}
        <fieldset className="rounded-lg border border-white/10 p-3">
          <legend className="px-1 text-xs text-muted">When are you free?</legend>
          <div className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <div key={i} className="flex flex-col gap-2">
                {rows.length > 1 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-muted">
                      Option {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRows((c) => c.filter((_, j) => j !== i))}
                      className="text-[11px] text-muted underline hover:text-offwhite"
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
                      className={chip(row.dateMode === mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {row.dateMode !== "any" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      className={`${input} sm:w-auto`}
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
                        <span className="text-xs text-muted">to</span>
                        <input
                          type="date"
                          className={`${input} sm:w-auto`}
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
                      className={chip(row.timeMode === mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {row.timeMode === "between" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      className={`${input} sm:w-auto`}
                      aria-label={`Option ${i + 1} start time`}
                      value={row.startTime}
                      onChange={(e) => patch(i, { startTime: e.target.value })}
                    />
                    <span className="text-xs text-muted">to</span>
                    <input
                      type="time"
                      className={`${input} sm:w-auto`}
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
                className="self-start text-xs text-muted underline hover:text-offwhite"
              >
                + Add another option
              </button>
            )}
          </div>
        </fieldset>

        {/* ---- consent: unchecked, and never a condition of joining ---- */}
        {phone.trim() && (
          <label className="flex items-start gap-2.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={smsConsent}
              onChange={(e) => setSmsConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/30 bg-white/5"
            />
            <span>{CONSENT_TEXT}</span>
          </label>
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
