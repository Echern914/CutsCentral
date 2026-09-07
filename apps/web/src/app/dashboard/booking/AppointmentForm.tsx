"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import type { ServiceRow, StaffRow } from "./page";
import {
  createAppointmentAction,
  getDashSlotsAction,
  searchClientsAction,
  type ClientOption,
  type DashSlot,
} from "./actions";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "New appointment" (native booking), in the SAME chrome as the appointment
 * sheet: ui/Dialog for the shell (focus trap, keyboard-aware viewport, sticky
 * footer), formkit's cards for the body. Service → provider → time → client →
 * note → repeat, then one solid-brass Schedule in the footer that can never
 * scroll below the fold. Times come from the real slot engine; "Custom time"
 * forces a time outside computed availability (overlap still blocked).
 * Prefills the date + hour tapped in the calendar.
 */
export function AppointmentForm({
  staff,
  services,
  timezone,
  prefillISO,
  waitlist,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  timezone: string;
  /** ISO instant of the tapped hour, prefills date + time. */
  prefillISO: string;
  /**
   * Booking someone straight off the waitlist (phase E). Prefills who/what/
   * which chair, shows what they actually asked for, and carries `entryId`
   * into the create call so the entry flips to BOOKED and links to the new
   * appointment inside the SAME transaction.
   */
  waitlist?: {
    entryId: string;
    name: string;
    phone: string | null;
    email: string | null;
    serviceId: string | null;
    staffId: string | null;
    windowHint: string | null;
  };
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);

  const [serviceId, setServiceId] = useState<string | null>(
    // A waitlist prefill wins over the single-option shortcut: it is what the
    // customer actually asked for.
    waitlist?.serviceId ??
      (activeServices.length === 1 ? activeServices[0]!.id : null),
  );
  const [staffId, setStaffId] = useState<string | null>(
    waitlist?.staffId ?? (activeStaff.length === 1 ? activeStaff[0]!.id : null),
  );
  const [startsAt, setStartsAt] = useState<string>(prefillISO);
  const [customTime, setCustomTime] = useState(false);
  const [slots, setSlots] = useState<DashSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [clientId, setClientId] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState<string>("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientOption[]>([]);
  const [newName, setNewName] = useState(waitlist?.name ?? "");
  const [newPhone, setNewPhone] = useState(waitlist?.phone ?? "");
  const [note, setNote] = useState("");
  // Recurrence: off by default ("Does not repeat"). When on, every N weeks for
  // `count` times OR until a date. Weekly only to start (the picked day+time is
  // the pattern). See engines/recurringSeries.ts.
  const [repeat, setRepeat] = useState(false);
  const [everyWeeks, setEveryWeeks] = useState(1);
  const [endMode, setEndMode] = useState<"count" | "until">("count");
  const [count, setCount] = useState(4);
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * The API refused because the time is blocked in the barber's EXTERNAL
   * calendar (Acuity). Held separately from `error` because it is not a dead
   * end: the sentence names the block, and the barber may confirm booking over
   * it - which the API then records. Nothing is written until he does.
   */
  const [blockConflict, setBlockConflict] = useState<BlockConflict | null>(null);
  const [pending, start] = useTransition();

  const selectedService = activeServices.find((s) => s.id === serviceId) ?? null;

  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [timezone],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
    [timezone],
  );
  // The shop-tz calendar day of the prefill, for the slots window.
  const dayKey = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(prefillISO)),
    [prefillISO, timezone],
  );

  // Load open slots for the chosen (staff, service) on the prefill day.
  useEffect(() => {
    if (!serviceId || !staffId || customTime) return;
    setLoadingSlots(true);
    const from = new Date(new Date(prefillISO).getTime() - 12 * 3600_000).toISOString();
    const to = new Date(new Date(prefillISO).getTime() + 36 * 3600_000).toISOString();
    getDashSlotsAction(staffId, serviceId, from, to).then((res) => {
      setLoadingSlots(false);
      if (res.ok && res.slots) {
        // Only slots on the tapped calendar day (shop tz).
        const sameDay = res.slots.filter(
          (s) =>
            new Intl.DateTimeFormat("en-CA", {
              timeZone: timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date(s.startsAt)) === dayKey,
        );
        setSlots(sameDay);
      } else {
        setSlots([]);
      }
    });
  }, [serviceId, staffId, customTime, prefillISO, dayKey, timezone]);

  // Debounced client search.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchClientsAction(query.trim()).then((res) => {
        if (res.ok && res.clients) setResults(res.clients.slice(0, 8));
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function submit(opts?: { confirmation?: string }) {
    // Read defensively: a footer button may hand us its click event, so only a
    // real string counts - never a truthiness test on whatever was passed.
    const externalBlockConfirmation =
      typeof opts?.confirmation === "string" && opts.confirmation.length > 0
        ? opts.confirmation
        : undefined;
    setBlockConflict(null);
    setError(null);
    if (!serviceId) return setError("Pick a service.");
    if (!staffId) return setError("Pick a provider.");
    if (!startsAt) return setError("Pick a time.");
    if (!clientId && !newName.trim()) return setError("Pick a client or enter a name.");
    if (repeat && endMode === "until" && !until) return setError("Pick an end date.");

    // `until` is inclusive of the chosen day (the server stops once an
    // occurrence starts AFTER untilDate), so send END of that day in the
    // SHOP's tz. The old browser-local-noon anchor cut afternoon occurrences
    // on the until-day even with everyone in the same zone.
    const untilISO = () => {
      const [y, m, d] = until.split("-").map(Number);
      return zonedWallTimeToUtc(y!, m! - 1, d!, 23 * 60 + 59, timezone).toISOString();
    };
    const recurrence = repeat
      ? {
          interval: everyWeeks,
          ...(endMode === "count" ? { count } : { until: untilISO() }),
        }
      : undefined;

    start(async () => {
      const res = await createAppointmentAction({
        staffId,
        serviceId,
        startsAt,
        clientId: clientId ?? undefined,
        firstName: clientId ? undefined : newName.trim(),
        phone: clientId ? undefined : newPhone.trim() || undefined,
        note: note.trim() || undefined,
        customTime,
        externalBlockConfirmation,
        recurrence,
        // Atomic waitlist link - see CreateApptInput.
        waitlistEntryId: waitlist?.entryId,
      });
      if (!res.ok) {
        if (res.error === "external_block") {
          // Show the block, ask - the booking happens only on confirm, and
          // only with the confirmation that names THIS block. A refusal that
          // arrives without one is still shown; it just cannot be confirmed.
          setBlockConflict({
            reason: res.reason ?? "That time is blocked in your external calendar.",
            confirmation: res.confirmation ?? "",
          });
          return;
        }
        setError(
          res.error === "slot_taken"
            ? "That time is already booked."
            : res.error === "invalid_slot"
              ? "That time isn't available. Use Custom time to force it."
              : "Couldn't schedule. Please try again.",
        );
        return;
      }
      // Recurring: surface partial success (some dates may have been unavailable).
      if (res.series) {
        const { booked, skipped } = res.series;
        if (booked === 0) {
          setError("None of those dates were available. Try a different time.");
          return;
        }
        toast(
          skipped.length > 0
            ? `Booked ${booked} — ${skipped.length} date${skipped.length > 1 ? "s were" : " was"} unavailable`
            : `Booked ${booked} appointments`,
          "success",
        );
      } else {
        toast("Appointment scheduled", "success");
      }
      onCreated();
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New appointment"
      titleAlign="center"
      className="sm:max-w-lg"
      footer={
        <FormFooter
          error={error}
          label="Schedule appointment"
          pendingLabel="Scheduling…"
          pending={pending}
          onSubmit={submit}
        />
      }
    >
      <div data-qa="new-appt-form" className="flex min-w-0 flex-col gap-5">
        {blockConflict && (
          <ExternalBlockBanner
            conflict={blockConflict}
            pending={pending}
            confirmLabel="Book over it"
            pendingLabel="Booking…"
            consequence="Booking here puts an appointment on time you blocked off there. It will be recorded as an override."
            onConfirm={() => submit({ confirmation: blockConflict.confirmation })}
            onDismiss={() => setBlockConflict(null)}
          />
        )}
        <Group title="Service">
          <div className="flex min-w-0 flex-col gap-1.5">
            {activeServices.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setServiceId(s.id)}
                className={cn(
                  "flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors duration-150 ease-out",
                  serviceId === s.id
                    ? "border-gold/50 bg-gold/10"
                    : "border-subtle hover:bg-charcoal-700/40",
                )}
              >
                <span className="min-w-0">
                  <span className="block [overflow-wrap:anywhere] font-medium text-offwhite">
                    {s.name}
                  </span>
                  <span className="block text-xs text-muted">
                    {s.durationMin} min{s.price != null ? ` · $${s.price.toFixed(0)}` : ""}
                  </span>
                </span>
                {serviceId === s.id && (
                  <span aria-hidden className="shrink-0 text-gold">
                    ✓
                  </span>
                )}
              </button>
            ))}
            {activeServices.length === 0 && (
              <p className="text-sm text-muted">Add a service first (Services tab).</p>
            )}
          </div>
        </Group>

        {activeStaff.length > 1 && (
          <Group title="Provider">
            <div className="flex flex-wrap gap-1.5">
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStaffId(s.id)}
                  className={chip(staffId === s.id, "px-4")}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </Group>
        )}

        <Group
          title={`Time · ${dayFmt.format(new Date(prefillISO))}`}
          action={
            <button
              type="button"
              onClick={() => setCustomTime((v) => !v)}
              // A real 44px hit area; the negative margin keeps the header line
              // visually as tight as the sheet's.
              className="-my-3 flex h-11 items-center px-2 text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-offwhite hover:underline"
            >
              {customTime ? "Pick from open slots" : "Custom time"}
            </button>
          }
        >
          {customTime ? (
            <input
              type="datetime-local"
              aria-label="Custom date and time"
              className={INPUT}
              onChange={(e) => {
                // datetime-local is naive wall clock; interpret in the SHOP's
                // zone (the schedule shown) - new Date(v) would use the device's
                // zone and shift the instant when the barber isn't in the shop tz.
                const v = e.target.value;
                if (!v) return;
                const [day, time] = v.split("T");
                const [y, m, d] = day!.split("-").map(Number);
                const [hh, mm] = time!.split(":").map(Number);
                setStartsAt(
                  zonedWallTimeToUtc(y!, m! - 1, d!, hh! * 60 + mm!, timezone).toISOString(),
                );
              }}
            />
          ) : loadingSlots ? (
            <p className="text-sm text-muted">Loading times…</p>
          ) : slots.length === 0 ? (
            <p className="text-xs text-muted">
              No open times this day. Use Custom time to force one.
            </p>
          ) : (
            <div className="grid min-w-0 grid-cols-3 gap-1.5">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  onClick={() => setStartsAt(s.startsAt)}
                  className={chip(startsAt === s.startsAt, "min-w-0 px-1 text-center")}
                >
                  {timeFmt.format(new Date(s.startsAt))}
                </button>
              ))}
            </div>
          )}
        </Group>

        <Group title="Client">
          {waitlist?.windowHint && (
            <p className="text-xs leading-snug text-muted">
              From the waitlist — they asked for{" "}
              <span className="text-offwhite">{waitlist.windowHint}</span>.
            </p>
          )}
          {clientId ? (
            <div className="flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gold/40 px-4 py-3 text-left text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere] font-medium text-offwhite">
                {clientLabel}
              </span>
              <button
                type="button"
                onClick={() => {
                  setClientId(null);
                  setClientLabel("");
                }}
                className="flex h-11 shrink-0 items-center rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <Field label="Find an existing client">
                <input
                  className={INPUT}
                  placeholder="Search name or number…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
              {results.length > 0 && (
                <ul className="flex flex-col gap-1 rounded-xl border border-subtle p-1">
                  {results.map((c) => {
                    const nm = c.name?.trim() || c.phone || "Client";
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setClientId(c.id);
                            setClientLabel(nm);
                            setResults([]);
                            setQuery("");
                          }}
                          className="flex min-h-[2.75rem] w-full flex-wrap items-center gap-x-2 rounded-lg px-3 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                        >
                          <span className="[overflow-wrap:anywhere]">{nm}</span>
                          {c.phone && <span className="text-xs text-muted">{c.phone}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-[11px] text-muted">or add a new client:</p>
              <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
                <Field label="Name">
                  <input
                    className={INPUT}
                    placeholder="Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </Field>
                <Field label="Phone" hint="Optional.">
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    className={INPUT}
                    placeholder="(201) 555-0134"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
        </Group>

        <Group title="Note">
          <Field label="Only you see this">
            <textarea
              className={cn(INPUT, "h-auto min-h-[4rem] resize-y py-2.5")}
              rows={2}
              placeholder="Optional note for this appointment"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </Group>

        <Group title="Repeat">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setRepeat(false)}
              className={chip(!repeat, "flex-1")}
            >
              Does not repeat
            </button>
            <button
              type="button"
              onClick={() => setRepeat(true)}
              className={chip(repeat, "flex-1")}
            >
              Weekly
            </button>
          </div>

          {repeat && (
            <div className="flex flex-col gap-3 rounded-xl border border-subtle bg-charcoal-900/50 p-3">
              <label className="flex items-center gap-2 text-sm text-offwhite">
                Every
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={everyWeeks}
                  onChange={(e) =>
                    setEveryWeeks(Math.min(8, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className={cn(INPUT, "w-20 px-2 text-center")}
                />
                {everyWeeks === 1 ? "week" : "weeks"}
              </label>

              <div className="flex flex-col gap-2">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEndMode("count")}
                    className={chip(endMode === "count", "flex-1")}
                  >
                    For a count
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndMode("until")}
                    className={chip(endMode === "until", "flex-1")}
                  >
                    Until a date
                  </button>
                </div>
                {endMode === "count" ? (
                  <label className="flex items-center gap-2 text-sm text-offwhite">
                    <input
                      type="number"
                      min={2}
                      max={52}
                      value={count}
                      onChange={(e) =>
                        setCount(Math.min(52, Math.max(2, Number(e.target.value) || 2)))
                      }
                      className={cn(INPUT, "w-20 px-2 text-center")}
                    />
                    appointments total
                  </label>
                ) : (
                  <input
                    type="date"
                    aria-label="Repeat until"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    className={INPUT}
                  />
                )}
              </div>
            </div>
          )}
        </Group>
      </div>
    </Dialog>
  );
}

/**
 * ⚠️ LEGACY SHELL — the booking forms have moved to ui/Dialog. Still consumed
 * by BookingManager's "Edit service" and weekly-hours sheets; migrate those
 * and this component goes. Do not add new consumers: Dialog has the focus
 * trap, the keyboard-aware viewport and the sticky footer; this has none.
 */
/**
 * The overlay every booking form rides in: a bottom sheet on phones, a centred
 * dialog from `sm` up.
 *
 * PORTALLED TO document.body, and that is load-bearing rather than tidiness.
 * ChairBack cards use `.glass`, which sets `backdrop-filter` - and any
 * non-`none` filter/backdrop-filter makes that element a CONTAINING BLOCK for
 * `position: fixed` descendants. Rendered in place, `fixed inset-0` would size
 * itself to the CARD instead of the viewport and its z-index would be trapped
 * in the card's stacking context: a sheet the width of an appointment row,
 * painted underneath the row below it. Portalling escapes both.
 *
 * Also handles the dialog basics the old inline version skipped: Escape to
 * close, focus moved in on open and restored on close, background scroll
 * locked, and proper dialog semantics for screen readers.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Background must not scroll under an open sheet on iOS.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the panel so a keyboard/screen-reader user lands inside the dialog
    // rather than continuing from wherever the trigger was.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-subtle bg-charcoal-900 p-5 outline-none sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="min-w-0 [overflow-wrap:anywhere] font-display text-lg text-offwhite">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 shrink-0 items-center rounded-full border border-subtle px-3 text-xs text-muted hover:text-offwhite sm:h-9"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
