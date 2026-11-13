"use client";

import { useRef, useState } from "react";
import { dateHoursSentence, datesLabel } from "@chairback/config/dateHoursPlan";
import { MAX_DATE_HOURS_NAME, type StoredDateHours } from "@chairback/config/servicePricing";
import { FormError } from "@/components/ui/FormError";
import { cn } from "@/lib/cn";
import { Sheet } from "./AppointmentForm";
import { nameServiceDatesAction, setServiceDateHoursAction } from "./actions";
import { changeSub, changeTitle, type DayChange } from "./dayChanges";
import { INPUT } from "./formkit";
import type { ServiceRow, StaffRow } from "./page";

/**
 * THE CHANGE, ON THE CALENDAR.
 *
 * "Change some days" lives on a service's own page, under Services. Once it
 * is saved, the day it changed looked like any other day: a barber opening
 * Thanksgiving week saw nothing that said haircuts start at 8. So the change
 * is drawn where the day is - a gold bar over the day's hours - and the bar
 * opens the change itself: name it, change it, do the same for another
 * service, or undo it.
 *
 * 🔴 The NAME is the shop's own label ("Thanksgiving week"). It is stored
 * inside the change, not with the shop's holiday names, because those are
 * printed on the public booking page and this is not for clients. It also
 * means an undone change takes its name with it.
 *
 * 🔴 What happened is said IN the sheet. A toast raised from inside a dialog
 * is drawn behind it on a phone.
 */

const namesOf = (change: DayChange, staff: readonly Pick<StaffRow, "id" | "name">[]) =>
  change.staffIds.map((id) => staff.find((s) => s.id === id)?.name).filter((n): n is string => Boolean(n));

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

/** One gold bar per service that runs its own hours on the day shown. */
export function DayChangeBars({
  changes,
  staff,
  onOpen,
}: {
  changes: DayChange[];
  staff: Pick<StaffRow, "id" | "name">[];
  onOpen: (change: DayChange) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <ul aria-label="Changed hours on this day" data-qa="day-change-bars" className="mb-3 flex flex-col gap-1.5">
      {changes.map((c) => {
        const title = changeTitle(c);
        const sub = changeSub(c, namesOf(c, staff));
        return (
          <li key={c.serviceId}>
            <button
              type="button"
              onClick={() => onOpen(c)}
              aria-label={`Changed hours: ${title}. ${sub}. Open this change`}
              className="flex min-h-[48px] w-full items-center gap-3 rounded-xl border border-gold/40 bg-gold/10 py-2 pl-0 pr-3 text-left transition-colors duration-150 ease-out hover:bg-gold/15"
            >
              <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-r-full bg-gold" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-gold [overflow-wrap:anywhere]">{title}</span>
                <span className="block text-xs text-offwhite/80 [overflow-wrap:anywhere]">{sub}</span>
              </span>
              <span className="text-gold">
                <Chevron />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What the server said, in words a barber can act on. */
function refusalCopy(error: string | undefined): string {
  switch (error) {
    case "past_date":
      return "One of those days has already passed. Close this and open the change again.";
    case "not_found":
      return "This service is no longer there. Close this and refresh.";
    default:
      return "That didn't save. Check your connection and try again.";
  }
}

const actionCls =
  "flex min-h-[52px] w-full items-center gap-3 border-b border-subtle px-3.5 py-2 text-left transition-colors duration-150 ease-out last:border-b-0 hover:bg-charcoal-700/40 disabled:opacity-50";

export function DayChangeSheet({
  change,
  services,
  staff,
  onClose,
  onSaved,
  onChangeDays,
  onRepeatFor,
}: {
  /** The change as it stood when the bar was tapped. */
  change: DayChange;
  /** Every service, for "do the same for another service". */
  services: Pick<ServiceRow, "id" | "name" | "active">[];
  staff: Pick<StaffRow, "id" | "name">[];
  onClose: () => void;
  /** The service's dated hours (and prices, when the save touched them) as the server now holds them. */
  onSaved: (serviceId: string, dateHours: StoredDateHours, dateOverrides?: Record<string, number>) => void;
  /** Open this service's dates on these days, to change them. */
  onChangeDays: () => void;
  /** Open ANOTHER service's dates with these days and hours filled in. */
  onRepeatFor: (serviceId: string, name: string | null) => void;
}) {
  const [savedName, setSavedName] = useState(change.name ?? "");
  const [name, setName] = useState(change.name ?? "");
  const [step, setStep] = useState<"main" | "pick" | "confirm" | "undone">("main");
  const [busy, setBusy] = useState(false);
  // A ref as well as state: two taps in one frame both read the same `busy`.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const current: DayChange = { ...change, name: savedName || null };
  const who = namesOf(change, staff);
  const sentence = dateHoursSentence({
    serviceName: change.serviceName,
    dates: change.dates,
    hours: change.hours.map((w) => ({ startMin: w.s, endMin: w.e })),
    price: change.price,
    staffNames: who,
  });
  const typed = name.trim();
  const nameDirty = typed !== savedName;
  const others = services.filter((s) => s.active && s.id !== change.serviceId);
  const days = change.dates.length === 1 ? "that day" : "those days";

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch {
      setError(refusalCopy(undefined));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const saveName = () =>
    run(async () => {
      const res = await nameServiceDatesAction(change.serviceId, { dates: change.dates, name: typed });
      if (!res.ok || !res.dateHours) {
        setError(refusalCopy(res.error));
        return;
      }
      setSavedName(typed);
      setName(typed);
      onSaved(change.serviceId, res.dateHours);
      setNote(typed ? `Named “${typed}”. Only you see the name.` : "Name taken off.");
    });

  const undo = () =>
    run(async () => {
      const res = await setServiceDateHoursAction(change.serviceId, { dates: change.dates, hours: null });
      if (!res.ok || !res.dateHours) {
        setError(refusalCopy(res.error));
        return;
      }
      onSaved(change.serviceId, res.dateHours, res.dateOverrides);
      setStep("undone");
      setNote(`${change.serviceName} is back to its usual hours on ${datesLabel(change.dates)}.`);
    });

  return (
    <Sheet title={step === "undone" ? "Change undone" : changeTitle(current)} onClose={onClose}>
      <div className="flex flex-col gap-5">
        {step !== "undone" && (
          <p className="rounded-xl border border-gold/30 bg-gold/10 px-3 py-2.5 text-sm leading-relaxed text-offwhite">
            {sentence} Everything else you offer keeps its usual day.
          </p>
        )}

        {step === "main" && (
          <>
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (nameDirty) void saveName();
              }}
            >
              <label htmlFor="day-change-name" className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Name (optional)
              </label>
              <div className="flex gap-2">
                <input
                  id="day-change-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNote(null);
                    setError(null);
                  }}
                  maxLength={MAX_DATE_HOURS_NAME}
                  placeholder="Holiday week"
                  autoComplete="off"
                  enterKeyHint="done"
                  aria-describedby="day-change-name-hint"
                  className={INPUT}
                />
                {nameDirty && (
                  <button
                    type="submit"
                    disabled={busy}
                    className="min-h-[44px] shrink-0 rounded-lg bg-gold px-3.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
                  >
                    {busy ? "Saving…" : typed ? "Save name" : "Take name off"}
                  </button>
                )}
              </div>
              <p id="day-change-name-hint" className="text-xs text-muted">
                A label for your own calendar. Clients never see it.
              </p>
            </form>

            <div className="overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/40">
              <button type="button" onClick={onChangeDays} disabled={busy} className={actionCls}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-offwhite">Change the days, hours or price</span>
                  <span className="block text-xs text-muted">Opens {change.serviceName}&apos;s dates on {days}</span>
                </span>
                <span className="text-muted">
                  <Chevron />
                </span>
              </button>
              {others.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNote(null);
                    setStep("pick");
                  }}
                  disabled={busy}
                  className={actionCls}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-offwhite">Do the same for another service</span>
                    <span className="block text-xs text-muted">Same days, same hours. You check it before it saves.</span>
                  </span>
                  <span className="text-muted">
                    <Chevron />
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setNote(null);
                  setStep("confirm");
                }}
                disabled={busy}
                className={actionCls}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-danger-soft">Undo this change</span>
                  <span className="block text-xs text-muted">
                    {change.serviceName} goes back to its usual hours on {days}
                  </span>
                </span>
              </button>
            </div>
          </>
        )}

        {step === "pick" && (
          <section aria-label="Pick a service" className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Which service gets the same?</h3>
            <div className="overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/40">
              {others.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onRepeatFor(s.id, savedName || null)}
                  className={actionCls}
                >
                  <span className="min-w-0 flex-1 text-sm text-offwhite [overflow-wrap:anywhere]">{s.name}</span>
                  <span className="text-muted">
                    <Chevron />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === "confirm" && (
          <section aria-label="Undo this change" className="flex flex-col gap-2 text-sm leading-relaxed text-offwhite">
            <p>
              Put {change.serviceName} back to its usual hours on {datesLabel(change.dates)}?
            </p>
            <p className="text-xs text-muted">
              Nobody already booked is moved or cancelled.
              {change.price !== null
                ? ` The price set for ${days} stays as it is: change it under Services, Special dates.`
                : ""}
            </p>
          </section>
        )}

        <div className="flex flex-col gap-3 border-t border-subtle pt-4">
          {note && (
            <p
              role="status"
              className="rounded-xl border border-emerald-soft/40 bg-emerald-soft/10 px-3 py-2.5 text-sm leading-relaxed text-offwhite"
            >
              {note}
            </p>
          )}
          <FormError>{error}</FormError>
          {step === "confirm" ? (
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setStep("main")}
                disabled={busy}
                className="min-h-[48px] flex-1 rounded-xl border border-subtle text-sm font-medium text-offwhite disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => void undo()}
                disabled={busy}
                className={cn(
                  "min-h-[48px] flex-[2] rounded-xl border border-danger-soft/60 text-sm font-semibold text-danger-soft disabled:opacity-50",
                )}
              >
                {busy ? "Undoing…" : "Undo the change"}
              </button>
            </div>
          ) : step === "pick" ? (
            <button
              type="button"
              onClick={() => setStep("main")}
              className="min-h-[48px] rounded-xl border border-subtle text-sm font-medium text-offwhite"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] rounded-xl bg-gold text-sm font-semibold text-charcoal-900"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
