"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  EMPTY_ROW,
  HORIZON_DAYS,
  MAX_WINDOWS,
  localDate,
  rowToWindow,
  type Row,
  type WaitlistWindowInput,
} from "@/lib/waitlistRows";
import { BTN_BASE } from "../_components/appointmentCardStyles";
import { createWaitlistEntryAction } from "./actions";
import type { StaffRow, ServiceRow } from "./page";
import type { Toast } from "@/components/ui/Toaster";

/**
 * Staff-side "put them on the list". A walk-in asks to be told when something
 * opens and, until phase E, the barber had no way to record it at all.
 *
 * 🔴 NO SMS CONSENT HERE, deliberately. The public form shows the customer a
 * checkbox and stores what they ticked; a barber cannot consent on someone
 * else's behalf, so this form never offers it and the API stores none. Nothing
 * is emailed either - the person is standing at the counter.
 *
 * The date/time rows are the SAME shared engine the two public forms use
 * (lib/waitlistRows), so an entry a barber types is indistinguishable to the
 * matcher from one the customer typed.
 */
export function WaitlistAddForm({
  staff,
  services,
  toast,
  onDone,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  toast: Toast;
  onDone: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const input =
    "h-11 w-full rounded-lg border border-subtle bg-charcoal-800 px-3.5 text-sm text-offwhite placeholder:text-muted focus:border-gold/50 sm:h-10";
  const chip = (on: boolean) =>
    cn(
      // 44px on mobile like every other tappable thing on this screen.
      "h-11 rounded-full border px-4 text-xs transition-colors sm:h-9 sm:px-3",
      on ? "border-gold/50 bg-gold/10 text-gold" : "border-subtle text-muted hover:text-offwhite",
    );

  function patch(i: number, next: Partial<Row>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
  }

  function submit() {
    setError(null);
    if (!firstName.trim()) {
      setError("Add their name.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so they can be reached.");
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
    start(async () => {
      const res = await createWaitlistEntryAction({
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        serviceId: serviceId || undefined,
        staffId: staffId || undefined,
        note: note.trim() || undefined,
        windows,
      });
      if (!res.ok) {
        setError(
          res.error === "already_waiting"
            ? "They're already on the list for this exact request."
            : "Couldn't add them. Please try again.",
        );
        return;
      }
      toast("Added to the waitlist", "success");
      onDone();
    });
  }

  const min = localDate();
  const max = localDate(HORIZON_DAYS);

  return (
    <Card className="p-5">
      <p className="font-display text-base">Add someone to the waitlist</p>
      <p className="mt-1 text-xs text-muted">
        They&rsquo;ll be matched exactly like someone who joined online. No text
        or email goes out &mdash; you&rsquo;re telling them in person.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <input
          className={input}
          placeholder="First name"
          aria-label="First name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          className={input}
          placeholder="Last name (optional)"
          aria-label="Last name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <input
          className={input}
          type="tel"
          inputMode="tel"
          placeholder="Mobile number"
          aria-label="Mobile number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <input
          className={input}
          type="email"
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          className={input}
          aria-label="Service"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Any service</option>
          {services
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <select
          className={input}
          aria-label="Provider"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">Any barber</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* ---- when they're free: the same rows the public forms use ---- */}
      <fieldset className="mt-4 rounded-xl border border-subtle p-3.5">
        <legend className="px-1 text-xs text-muted">When are they free?</legend>
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
                    className={cn(input, "sm:w-auto")}
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
                        className={cn(input, "sm:w-auto")}
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
                    className={cn(input, "sm:w-auto")}
                    aria-label={`Option ${i + 1} start time`}
                    value={row.startTime}
                    onChange={(e) => patch(i, { startTime: e.target.value })}
                  />
                  <span className="text-xs text-muted">to</span>
                  <input
                    type="time"
                    className={cn(input, "sm:w-auto")}
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

      <input
        className={cn(input, "mt-3")}
        placeholder="Note (optional)"
        aria-label="Note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-danger-soft">
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <button
          type="button"
          onClick={onDone}
          className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite sm:w-auto sm:px-5")}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          aria-busy={pending}
          className={cn(BTN_BASE, "bg-gold font-semibold text-charcoal-900 hover:bg-gold/90 sm:w-auto sm:px-5")}
        >
          {pending ? "Adding…" : "Add to waitlist"}
        </button>
      </div>
    </Card>
  );
}
