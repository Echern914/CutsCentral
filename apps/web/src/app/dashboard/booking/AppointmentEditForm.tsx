"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { cn } from "@/lib/cn";
import {
  editAppointmentAction,
  getEditContextAction,
  type AppointmentDetail,
  type EditContext,
} from "./actions";
import type { AgendaRow } from "./page";

/** Same local alias the sibling booking forms use - the provider's own
 * `Toast` interface is a toast OBJECT and is not exported. */
type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * EDITING AN APPOINTMENT — the fields, and the one save.
 *
 * Split into a hook plus a field block on purpose: the appointment sheet keeps
 * its primary action in the dialog's own FOOTER, which is flex-none and
 * therefore never scrolls away on a phone. A component that rendered its own
 * Save at the end of a scrolling body could not do that, and "the Save button
 * is somewhere below the fold" is exactly the failure a sticky footer exists
 * to prevent. So the state lives in `useAppointmentEdit`, the parent renders
 * `<AppointmentEditFields>` in the body and `state.save` in the footer.
 *
 * The form is deliberately thin: every rule that decides whether a change is
 * ALLOWED lives on the server (availability, the advisory lock, overlap, the
 * paid-price refusal, the E.164 phone rule). This screen's job is to prefill
 * honestly, send ONLY what actually changed, and report back plainly -
 * including when Acuity did not confirm a move.
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

export interface AppointmentEditState {
  ctx: EditContext | null;
  loadError: boolean;
  pending: boolean;
  save: () => void;
  row: AgendaRow;
  detail: AppointmentDetail | null;
  fields: {
    serviceId: string | null;
    setServiceId: (v: string | null) => void;
    staffId: string | null;
    setStaffId: (v: string | null) => void;
    date: string;
    setDate: (v: string) => void;
    time: string;
    setTime: (v: string) => void;
    durationMin: number;
    setDurationMin: (v: number) => void;
    price: string;
    setPrice: (v: string) => void;
    notes: string;
    setNotes: (v: string) => void;
    phone: string;
    setPhone: (v: string) => void;
    email: string;
    setEmail: (v: string) => void;
    clientId: string | null;
    setClientId: (v: string | null) => void;
    clientQuery: string;
    setClientQuery: (v: string) => void;
    clientName: string;
    setClientName: (v: string) => void;
    changingClient: boolean;
    setChangingClient: (v: boolean) => void;
  };
}

export function useAppointmentEdit({
  row,
  detail,
  toast,
  onSaved,
}: {
  row: AgendaRow;
  /** Null while the sheet is still loading - contact editing waits for it. */
  detail: AppointmentDetail | null;
  toast: Toast;
  onSaved: () => void;
}): AppointmentEditState {
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
  const [clientName, setClientName] = useState<string>(row.clientName);
  const [clientQuery, setClientQuery] = useState("");
  const [changingClient, setChangingClient] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

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

  // Contact prefills from the DETAIL read, which resolved the number the app
  // would actually text (the client record), not whatever the booker typed.
  // Until it lands there is no honest baseline, so the fields stay hidden -
  // offering an empty box over a number we have not read yet invites a barber
  // to blank out a working phone by saving.
  useEffect(() => {
    if (!detail) return;
    setPhone(detail.contact.phoneDisplay ?? detail.contact.phone ?? "");
    setEmail(detail.contact.email ?? "");
  }, [detail]);

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
    // Contact only when the detail read gave us something to compare against.
    if (detail) {
      const basePhone = detail.contact.phoneDisplay ?? detail.contact.phone ?? "";
      const baseEmail = detail.contact.email ?? "";
      if (phone.trim() !== basePhone.trim()) patch.phone = phone.trim() || null;
      if (email.trim() !== baseEmail.trim()) patch.email = email.trim() || null;
    }

    if (Object.keys(patch).length === 0) {
      toast("Nothing to save yet");
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

  return {
    ctx,
    loadError,
    pending,
    save,
    row,
    detail,
    fields: {
      serviceId,
      setServiceId,
      staffId,
      setStaffId,
      date,
      setDate,
      time,
      setTime,
      durationMin,
      setDurationMin,
      price,
      setPrice,
      notes,
      setNotes,
      phone,
      setPhone,
      email,
      setEmail,
      clientId,
      setClientId,
      clientQuery,
      setClientQuery,
      clientName,
      setClientName,
      changingClient,
      setChangingClient,
    },
  };
}

/**
 * The fields, grouped the way a barber thinks about the booking: who it is,
 * when and with whom, what it costs, and the note only they see.
 */
export function AppointmentEditFields({ state }: { state: AppointmentEditState }) {
  const { ctx, row, detail, fields: f } = state;

  const matches = useMemo(() => {
    const q = f.clientQuery.trim().toLowerCase();
    if (!ctx || q.length < 2) return [];
    return ctx.clients
      .filter((c) => `${c.name} ${c.phone ?? ""}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [ctx, f.clientQuery]);

  if (state.loadError) {
    return (
      <p className="text-sm text-muted">
        Couldn&apos;t load your services just now. Close this and try again.
      </p>
    );
  }
  if (!ctx) {
    return <p className="text-sm text-muted">Loading your services…</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      {row.status === "pending" && (
        <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-300">
          This is still a <strong>request</strong>. Editing it keeps it a request — approve
          it from the card when you&apos;re ready.
        </p>
      )}

      <Group title="Client">
        <Field label="Name">
          {!f.changingClient ? (
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 self-center [overflow-wrap:anywhere] text-base text-offwhite">
                {f.clientName}
              </span>
              <button
                type="button"
                onClick={() => f.setChangingClient(true)}
                className="h-11 shrink-0 rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                value={f.clientQuery}
                onChange={(e) => f.setClientQuery(e.target.value)}
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
                        f.setClientId(c.id);
                        f.setClientName(c.name);
                        f.setClientQuery("");
                        f.setChangingClient(false);
                      }}
                      className={cn(
                        "flex min-h-[2.75rem] w-full flex-wrap items-center gap-x-2 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 ease-out hover:bg-charcoal-700",
                        f.clientId === c.id ? "text-gold" : "text-offwhite",
                      )}
                    >
                      <span className="[overflow-wrap:anywhere]">{c.name}</span>
                      {c.phone && <span className="text-xs text-muted">{c.phone}</span>}
                    </button>
                  </li>
                ))}
                {f.clientQuery.trim().length >= 2 && matches.length === 0 && (
                  <li className="px-1 py-2 text-xs text-muted">No matching client.</li>
                )}
              </ul>
            </>
          )}
        </Field>

        {/* Contact is editable only once the sheet has READ the current values.
            Without that baseline, an empty box would look like "no number on
            file" and a save would wipe a working one. */}
        {detail ? (
          <>
            <Field
              label="Phone"
              hint="Fixing a number never grants permission to text it."
            >
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={f.phone}
                onChange={(e) => f.setPhone(e.target.value)}
                placeholder="(201) 555-0134"
                className={INPUT}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={f.email}
                onChange={(e) => f.setEmail(e.target.value)}
                placeholder="name@example.com"
                className={INPUT}
              />
            </Field>
          </>
        ) : (
          <p className="text-xs text-muted">Loading contact details…</p>
        )}
      </Group>

      <Group title="Appointment">
        <Field label="Service">
          <select
            value={f.serviceId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              f.setServiceId(id);
              const svc = ctx.services.find((s) => s.id === id);
              if (svc) f.setDurationMin(svc.durationMin);
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
            value={f.staffId ?? ""}
            onChange={(e) => f.setStaffId(e.target.value || null)}
            className={INPUT}
          >
            {ctx.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 gap-4 min-[380px]:grid-cols-2">
          <Field label="Date">
            <input
              type="date"
              value={f.date}
              onChange={(e) => f.setDate(e.target.value)}
              className={INPUT}
            />
          </Field>
          <Field label="Start">
            <input
              type="time"
              value={f.time}
              onChange={(e) => f.setTime(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>

        <Field label="Minutes">
          <input
            type="number"
            min={5}
            max={600}
            step={5}
            value={f.durationMin}
            onChange={(e) => f.setDurationMin(Number(e.target.value))}
            className={INPUT}
          />
        </Field>
      </Group>

      <Group title="Payment">
        <Field
          label="Price"
          hint={
            detail?.payment.state === "paid" || detail?.payment.state === "deposit"
              ? "Already collected — refund or take the difference in person before changing this."
              : undefined
          }
        >
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted"
            >
              $
            </span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={f.price}
              onChange={(e) => f.setPrice(e.target.value)}
              placeholder="—"
              className={cn(INPUT, "pl-7")}
            />
          </div>
        </Field>
      </Group>

      <Group title="Notes">
        <Field label="Only you see this">
          <textarea
            value={f.notes}
            onChange={(e) => f.setNotes(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder="Moved from Saturday…"
            className={cn(INPUT, "h-auto min-h-[5rem] resize-y py-2.5")}
          />
        </Field>
      </Group>
    </div>
  );
}

/** 16px floor on inputs - anything smaller makes iOS zoom the whole page. */
const INPUT =
  "h-11 w-full rounded-lg border border-subtle bg-charcoal-900 px-3 text-base text-offwhite transition-colors duration-150 ease-out placeholder:text-muted/60 focus-visible:border-gold/50";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
        {title}
      </h3>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted/80">{hint}</span>}
    </label>
  );
}

const ERROR_COPY: Record<string, string> = {
  slot_taken: "That time is already taken on this chair.",
  invalid_slot: "That time is outside your booking hours.",
  invalid_phone: "That phone number isn't one we can dial — check the digits.",
  price_change_on_paid:
    "This booking is already paid — refund or take the difference in person first.",
  synced_appointment_readonly: "This one is managed in Acuity.",
  not_editable: "This appointment can no longer be edited.",
  client_not_found: "That client isn't in your book.",
  staff_not_found: "That barber is no longer available.",
  service_not_found: "That service is no longer available.",
};
