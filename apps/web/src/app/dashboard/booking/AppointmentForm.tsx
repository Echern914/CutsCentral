"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import type { ServiceRow, StaffRow } from "./page";
import {
  createAppointmentAction,
  getDashSlotsAction,
  searchClientsAction,
  type ClientOption,
  type DashSlot,
} from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * ChairBack-styled "New Appointment" sheet (native booking). Mirrors the Acuity
 * flow the barber shared - service → provider → date/time → client → notes →
 * Schedule - in the app's dark/gold chrome. Times come from the real slot engine;
 * "Custom time" forces a time outside computed availability (overlap still
 * blocked). Prefills the date + hour tapped in the calendar.
 */
export function AppointmentForm({
  staff,
  services,
  timezone,
  prefillISO,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  timezone: string;
  /** ISO instant of the tapped hour, prefills date + time. */
  prefillISO: string;
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);

  const [serviceId, setServiceId] = useState<string | null>(
    activeServices.length === 1 ? activeServices[0]!.id : null,
  );
  const [staffId, setStaffId] = useState<string | null>(
    activeStaff.length === 1 ? activeStaff[0]!.id : null,
  );
  const [startsAt, setStartsAt] = useState<string>(prefillISO);
  const [customTime, setCustomTime] = useState(false);
  const [slots, setSlots] = useState<DashSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [clientId, setClientId] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState<string>("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientOption[]>([]);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
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

  function submit() {
    setError(null);
    if (!serviceId) return setError("Pick a service.");
    if (!staffId) return setError("Pick a provider.");
    if (!startsAt) return setError("Pick a time.");
    if (!clientId && !newName.trim()) return setError("Pick a client or enter a name.");
    if (repeat && endMode === "until" && !until) return setError("Pick an end date.");

    const recurrence = repeat
      ? {
          interval: everyWeeks,
          ...(endMode === "count"
            ? { count }
            : { until: new Date(`${until}T12:00:00`).toISOString() }),
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
        recurrence,
      });
      if (!res.ok) {
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

  const label = "text-[11px] font-medium uppercase tracking-wide text-muted";
  const rowBtn =
    "flex w-full items-center justify-between gap-3 rounded-xl border border-subtle px-4 py-3 text-left text-sm transition-colors hover:bg-charcoal-700/40";

  return (
    <Sheet title="New appointment" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Service */}
        <div>
          <p className={label}>Service</p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {activeServices.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setServiceId(s.id)}
                className={cn(
                  rowBtn,
                  serviceId === s.id && "border-gold/50 bg-gold/10",
                )}
              >
                <span>
                  <span className="block font-medium text-offwhite">{s.name}</span>
                  <span className="block text-xs text-muted">
                    {s.durationMin} min{s.price != null ? ` · $${s.price.toFixed(0)}` : ""}
                  </span>
                </span>
                {serviceId === s.id && <span className="text-gold">✓</span>}
              </button>
            ))}
            {activeServices.length === 0 && (
              <p className="text-sm text-muted">Add a service first (Services tab).</p>
            )}
          </div>
        </div>

        {/* Provider (only if multiple) */}
        {activeStaff.length > 1 && (
          <div>
            <p className={label}>Provider</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStaffId(s.id)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    staffId === s.id
                      ? "border-gold/50 bg-gold/10 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Time */}
        <div>
          <div className="flex items-center justify-between">
            <p className={label}>Time · {dayFmt.format(new Date(prefillISO))}</p>
            <button
              type="button"
              onClick={() => setCustomTime((v) => !v)}
              className="text-[11px] text-muted underline-offset-2 hover:text-offwhite hover:underline"
            >
              {customTime ? "Pick from open slots" : "Custom time"}
            </button>
          </div>
          {customTime ? (
            <input
              type="datetime-local"
              className="mt-1.5 w-full rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite"
              onChange={(e) => {
                // datetime-local is naive local; interpret in the viewer's zone.
                const v = e.target.value;
                if (v) setStartsAt(new Date(v).toISOString());
              }}
            />
          ) : loadingSlots ? (
            <p className="mt-1.5 text-sm text-muted">Loading times…</p>
          ) : slots.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted">
              No open times this day. Use Custom time to force one.
            </p>
          ) : (
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  onClick={() => setStartsAt(s.startsAt)}
                  className={cn(
                    "rounded-lg border py-2 text-center text-sm transition-colors",
                    startsAt === s.startsAt
                      ? "border-gold/50 bg-gold/15 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {timeFmt.format(new Date(s.startsAt))}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Client */}
        <div>
          <p className={label}>Client</p>
          {clientId ? (
            <div className={cn(rowBtn, "mt-1.5 border-gold/40")}>
              <span className="font-medium text-offwhite">{clientLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setClientId(null);
                  setClientLabel("");
                }}
                className="text-xs text-muted hover:text-offwhite"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex flex-col gap-2">
              <input
                className="w-full rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted"
                placeholder="Search existing clients…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {results.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-subtle p-1">
                  {results.map((c) => {
                    const nm = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.phone || "Client";
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setClientId(c.id);
                          setClientLabel(nm);
                          setResults([]);
                          setQuery("");
                        }}
                        className="rounded px-3 py-2 text-left text-sm text-offwhite hover:bg-charcoal-700"
                      >
                        {nm}
                        {c.phone && <span className="ml-2 text-xs text-muted">{c.phone}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted">or add a new client:</p>
              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted"
                  placeholder="Name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  className="min-w-0 flex-1 rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted"
                  placeholder="Phone (optional)"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Note */}
        <div>
          <p className={label}>Note</p>
          <textarea
            className="mt-1.5 w-full rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted"
            rows={2}
            placeholder="Optional note for this appointment"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Repeat (recurring series) */}
        <div>
          <p className={label}>Repeat</p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={() => setRepeat(false)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                !repeat
                  ? "border-gold/50 bg-gold/10 text-gold"
                  : "border-subtle text-muted hover:text-offwhite",
              )}
            >
              Does not repeat
            </button>
            <button
              type="button"
              onClick={() => setRepeat(true)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                repeat
                  ? "border-gold/50 bg-gold/10 text-gold"
                  : "border-subtle text-muted hover:text-offwhite",
              )}
            >
              Weekly
            </button>
          </div>

          {repeat && (
            <div className="mt-3 flex flex-col gap-3 rounded-lg border border-subtle bg-charcoal-800/40 p-3">
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
                  className="w-16 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-sm text-offwhite"
                />
                {everyWeeks === 1 ? "week" : "weeks"}
              </label>

              <div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEndMode("count")}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      endMode === "count"
                        ? "border-gold/50 bg-gold/10 text-gold"
                        : "border-subtle text-muted hover:text-offwhite",
                    )}
                  >
                    For a count
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndMode("until")}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      endMode === "until"
                        ? "border-gold/50 bg-gold/10 text-gold"
                        : "border-subtle text-muted hover:text-offwhite",
                    )}
                  >
                    Until a date
                  </button>
                </div>
                {endMode === "count" ? (
                  <label className="mt-2 flex items-center gap-2 text-sm text-offwhite">
                    <input
                      type="number"
                      min={2}
                      max={52}
                      value={count}
                      onChange={(e) =>
                        setCount(Math.min(52, Math.max(2, Number(e.target.value) || 2)))
                      }
                      className="w-16 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-sm text-offwhite"
                    />
                    appointments total
                  </label>
                ) : (
                  <input
                    type="date"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite"
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-danger-soft">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="w-full rounded-xl bg-gold py-3 text-center text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
        >
          {pending ? "Scheduling…" : "Schedule appointment"}
        </button>
      </div>
    </Sheet>
  );
}

/** Simple bottom-sheet-style modal shell in the app's dark chrome. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-subtle bg-charcoal-900 p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg text-offwhite">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-subtle px-3 py-1 text-xs text-muted hover:text-offwhite"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
