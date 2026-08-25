"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { cn } from "@/lib/cn";
import { BTN_BASE } from "../_components/appointmentCardStyles";
import { Sheet } from "./AppointmentForm";
import {
  editAppointmentAction,
  getEditContextAction,
  type EditContext,
} from "./actions";
import type { AgendaRow } from "./page";
import type { Toast } from "@/components/ui/Toast";

/**
 * EDIT AN APPOINTMENT.
 *
 * Rides in the shared `Sheet` - bottom sheet on phones, centred dialog on
 * desktop - so it is portalled out of the card's `backdrop-filter` containing
 * block and inherits Escape-to-close, focus handling and scroll locking.
 *
 * The form is deliberately thin: every rule that decides whether a change is
 * ALLOWED lives on the server (availability, the advisory lock, overlap, the
 * paid-price refusal). This screen's job is to prefill honestly, send only
 * what actually changed, and report back plainly - including when Acuity did
 * not confirm the move.
 */

/** Wall-clock helpers: the shop's timezone is the one that matters, not the browser's. */
function toLocalParts(iso: string, timezone: string): { date: string; time: string } {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
  };
}

export function AppointmentEditSheet({
  row,
  toast,
  onClose,
  onSaved,
}: {
  row: AgendaRow;
  toast: Toast;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ctx, setCtx] = useState<EditContext | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, start] = useTransition();

  // Prefilled from the row, then reconciled with the real service/staff lists.
  const [serviceId, setServiceId] = useState<string | null>(row.serviceId ?? null);
  const [staffId, setStaffId] = useState<string | null>(row.staffId ?? null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [durationMin, setDurationMin] = useState<number>(() =>
    row.end
      ? Math.round((new Date(row.end).getTime() - new Date(row.start).getTime()) / 60_000)
      : 30,
  );
  const [price, setPrice] = useState<string>(row.price != null ? String(row.price) : "");
  const [notes, setNotes] = useState<string>(row.notes ?? "");
  const [clientId, setClientId] = useState<string | null>(row.clientId ?? null);
  const [clientQuery, setClientQuery] = useState("");
  const [changingClient, setChangingClient] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getEditContextAction();
      if (!alive) return;
      if (res.ok && res.data) {
        setCtx(res.data);
        const parts = toLocalParts(row.start, res.data.timezone);
        setDate(parts.date);
        setTime(parts.time);
      } else {
        setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [row.start]);

  const matches = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!ctx || q.length < 2) return [];
    return ctx.clients
      .filter((c) => `${c.name} ${c.phone ?? ""}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [ctx, clientQuery]);

  function save() {
    if (!ctx) return;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
      toast("Pick a valid date and time", "error");
      return;
    }
    const startsAt = zonedWallTimeToUtc(y, m - 1, d, hh * 60 + mm, ctx.timezone);

    // Send only what CHANGED. A field the barber never touched must not be
    // rewritten - that is how an untouched price silently becomes null.
    const patch: Record<string, unknown> = {};
    if (startsAt.toISOString() !== row.start) patch.startsAt = startsAt.toISOString();
    if (staffId && staffId !== row.staffId) patch.staffId = staffId;
    if (serviceId && serviceId !== row.serviceId) patch.serviceId = serviceId;
    const originalDuration = row.end
      ? Math.round((new Date(row.end).getTime() - new Date(row.start).getTime()) / 60_000)
      : null;
    if (durationMin !== originalDuration) patch.durationMin = durationMin;
    const priceNum = price.trim() === "" ? null : Number(price);
    if (priceNum !== (row.price ?? null) && !Number.isNaN(priceNum)) patch.price = priceNum;
    if (notes !== (row.notes ?? "")) patch.notes = notes || null;
    if (clientId !== (row.clientId ?? null)) patch.clientId = clientId;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    start(async () => {
      const res = await editAppointmentAction(row.id, patch);
      if (!res.ok) {
        toast(ERROR_COPY[res.error ?? ""] ?? "Couldn't save those changes", "error");
        return;
      }
      // Honest about the Acuity half. A move whose block did not confirm is
      // NOT a clean success, and saying so is the whole point of reporting it.
      if (res.mirror === "unknown") {
        toast("Saved — still confirming the time on Acuity", "success");
      } else if (res.mirror === "failed") {
        toast("Saved here, but Acuity didn't confirm — the old time stays held", "error");
      } else {
        toast(res.status === "PENDING" ? "Request updated" : "Appointment updated", "success");
      }
      onSaved();
    });
  }

  const title = row.status === "pending" ? "Edit request" : "Edit appointment";

  if (loadError) {
    return (
      <Sheet title={title} onClose={onClose}>
        <p className="text-sm text-muted">
          Couldn&apos;t load your services just now. Close this and try again.
        </p>
      </Sheet>
    );
  }
  if (!ctx) {
    return (
      <Sheet title={title} onClose={onClose}>
        <p className="text-sm text-muted">Loading…</p>
      </Sheet>
    );
  }

  return (
    <Sheet title={title} onClose={onClose}>
      {row.status === "pending" && (
        <p className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
          This is still a <strong>request</strong>. Editing it keeps it a request — approve it
          from the card when you&apos;re ready.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {/* CLIENT - changing it is an explicit search, never a free-text rename. */}
        <Field label="Client">
          {!changingClient ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 [overflow-wrap:anywhere] text-sm text-offwhite">
                {row.clientName}
              </span>
              <button
                type="button"
                onClick={() => setChangingClient(true)}
                className="h-11 shrink-0 rounded-lg border border-subtle px-3 text-xs text-muted hover:text-offwhite sm:h-9"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Search name or number…"
                aria-label="Search for a client"
                className={INPUT}
              />
              <ul className="mt-1 flex flex-col gap-1">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setClientId(c.id);
                        setClientQuery(c.name);
                        setChangingClient(false);
                      }}
                      className={cn(
                        "w-full rounded-md px-3 py-2 text-left text-xs hover:bg-charcoal-700",
                        clientId === c.id ? "text-gold" : "text-offwhite",
                      )}
                    >
                      {c.name}
                      {c.phone && <span className="ml-2 text-muted">{c.phone}</span>}
                    </button>
                  </li>
                ))}
                {clientQuery.trim().length >= 2 && matches.length === 0 && (
                  <li className="px-1 py-2 text-xs text-muted">No matching client.</li>
                )}
              </ul>
            </>
          )}
        </Field>

        <Field label="Service">
          <select
            value={serviceId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              setServiceId(id);
              const svc = ctx.services.find((s) => s.id === id);
              if (svc) setDurationMin(svc.durationMin);
            }}
            className={INPUT}
          >
            {ctx.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Barber">
          <select
            value={staffId ?? ""}
            onChange={(e) => setStaffId(e.target.value || null)}
            className={INPUT}
          >
            {ctx.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
          </Field>
          <Field label="Start">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={INPUT} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Minutes">
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Price">
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="—"
              className={INPUT}
            />
          </Field>
        </div>

        <Field label="Note (only you see this)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder="Moved from Saturday…"
            className={cn(INPUT, "min-h-[5rem] resize-y")}
          />
        </Field>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className={cn(BTN_BASE, "bg-gold font-semibold text-charcoal-900 hover:bg-gold/90")}
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Sheet>
  );
}

/** 16px floor on inputs - anything smaller makes iOS zoom the whole page. */
const INPUT =
  "h-11 w-full rounded-lg border border-subtle bg-charcoal-900 px-3 text-base text-offwhite placeholder:text-muted/60 sm:h-10";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

const ERROR_COPY: Record<string, string> = {
  slot_taken: "That time is already taken on this chair.",
  invalid_slot: "That time is outside your booking hours.",
  price_change_on_paid:
    "This booking is already paid — refund or take the difference in person first.",
  synced_appointment_readonly: "This one is managed in Acuity.",
  not_editable: "This appointment can no longer be edited.",
  client_not_found: "That client isn't in your book.",
  staff_not_found: "That barber is no longer available.",
  service_not_found: "That service is no longer available.",
};
