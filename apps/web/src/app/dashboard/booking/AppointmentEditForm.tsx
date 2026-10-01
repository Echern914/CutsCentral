"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import type { BusinessVocabulary } from "@chairback/config/businessTypes";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { cn } from "@/lib/cn";
import {
  editAppointmentAction,
  getEditContextAction,
  type AppointmentDetail,
  type EditContext,
} from "./actions";
import type { AgendaRow } from "./page";
import { Field, Group, INPUT } from "./formkit";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";

/**
 * What a successful save says, for the sheet to show in its own footer.
 *
 * 🔴 NOT A TOAST. The toast layer draws beneath the dialog, so on a phone a
 * save that worked looked exactly like one that did nothing - the barber
 * pressed Save, the sheet flipped back, and there was no word that it had
 * saved. `warning` is a save that landed here but not on Acuity.
 */
export interface SavedNotice {
  message: string;
  tone: "success" | "warning";
}

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

/** The booking's current length in minutes, or null when the row has no end. */
function spanMinutes(row: AgendaRow): number | null {
  return row.end
    ? Math.round((new Date(row.end).getTime() - new Date(row.start).getTime()) / 60_000)
    : null;
}

/**
 * 🔴 DURATION IS TEXT, NOT A NUMBER. Held as a number, clearing the box gave
 * `Number("") === 0`, React wrote that 0 back into the input, and it could not
 * be deleted - typing 30 then read "030". An empty box now stays empty, with a
 * grey "0" placeholder, and the text is parsed only when it is compared or
 * sent. Blank MEANS zero, so a booking with no length is not a change.
 */
const DURATION_MIN = 5;
const DURATION_MAX = 600;

export interface AppointmentEditState {
  ctx: EditContext | null;
  loadError: boolean;
  pending: boolean;
  /**
   * True once something on the form differs from the booking - including a
   * value that is not valid yet, so tapping Save can say what is wrong with
   * it. The footer's Save stays disabled until then.
   */
  dirty: boolean;
  /**
   * Why the last Save did not go through, in the barber's words. Rendered in
   * the sheet's FOOTER, directly above Save: a toast draws beneath the
   * dialog, so on a phone every refusal used to be invisible and a tap on
   * Save looked like nothing happened. Cleared by the next edit or save.
   */
  saveError: string | null;
  /**
   * The footer hands this its click event, so it reads its argument
   * defensively - only a real confirmation string counts.
   */
  save: (opts?: { confirmation?: string; overlap?: string }) => void;
  /**
   * The one refusal a barber can answer: this edit would land on time he
   * blocked in the calendar he manages. Null unless the server said so, and
   * cleared only by saving successfully or by choosing another time - NOT by
   * anything that merely re-reads the calendar underneath.
   */
  blockConflict: BlockConflict | null;
  confirmBlock: () => void;
  dismissBlock: () => void;
  /**
   * The move lands on another booking, a synced visit or one of his specials:
   * named, with "Book anyway" and its second-tap question. Or a customer's
   * live hold - named, with nothing to confirm. Forgotten the moment the form
   * changes: it was a question about THAT time.
   */
  overlapConflict: BlockConflict | null;
  confirmOverlap: () => void;
  dismissOverlap: () => void;
  /**
   * The time isn't one of this service's usual openings (invalid_slot) - off
   * its usual start times, outside the hours, inside the booking notice. Those
   * are rules for CUSTOMERS booking online; the barber editing his own
   * calendar can keep the time anyway (the API's `customTime`, the same
   * override New appointment's custom time sends). Overlap is still checked.
   */
  offHoursConflict: BlockConflict | null;
  confirmOffHours: () => void;
  dismissOffHours: () => void;
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
    /** Minutes, as typed. See DURATION IS TEXT above. */
    duration: string;
    setDuration: (v: string) => void;
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
  onSaved,
}: {
  row: AgendaRow;
  /** Null while the sheet is still loading - contact editing waits for it. */
  detail: AppointmentDetail | null;
  /** Called once per successful save, with what to tell the barber. */
  onSaved: (notice: SavedNotice) => void;
}): AppointmentEditState {
  const vocab = useVocab();
  const [ctx, setCtx] = useState<EditContext | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, start] = useTransition();

  // Prefilled from the row, then reconciled with the real service/staff lists.
  const [serviceId, setServiceId] = useState<string | null>(row.serviceId ?? null);
  const [staffId, setStaffId] = useState<string | null>(row.staffId ?? null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState<string>(() => {
    const min = spanMinutes(row) ?? 30;
    return min > 0 ? String(min) : "";
  });
  const [price, setPrice] = useState<string>(row.price != null ? String(row.price) : "");
  const [notes, setNotes] = useState<string>(row.notes ?? "");
  const [clientId, setClientId] = useState<string | null>(row.clientId ?? null);
  const [clientName, setClientName] = useState<string>(row.clientName);
  const [clientQuery, setClientQuery] = useState("");
  const [changingClient, setChangingClient] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [blockConflict, setBlockConflict] = useState<BlockConflict | null>(null);
  const [overlapConflict, setOverlapConflict] = useState<BlockConflict | null>(null);
  // The overlap he already said yes to, carried on the retry that follows - so
  // answering an overlap and THEN an Acuity block sends both answers.
  const acceptedOverlap = useRef<string | null>(null);
  // "Save anyway" on a time that isn't a usual opening: carried the same way.
  const [offHoursConflict, setOffHoursConflict] = useState<BlockConflict | null>(null);
  const acceptedCustomTime = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 🔴 NOT useTransition's `isPending` on its own. React 18 ends a transition
  // when the callback RETURNS, and an async callback returns its promise
  // immediately - so isPending is false for the entire time the request is
  // actually in flight, and every "Saving…" that trusts it flickers off before
  // the save has happened. This flag spans the await.
  const [saving, setSaving] = useState(false);
  // 🔴 A REF, not `pending`. Two clicks landing in the same tick both read the
  // transition's pending as false and both fire - which on the confirm button
  // would be two writes over the same block and two audit rows. The ref flips
  // synchronously, so the second click has nothing to do.
  const inFlight = useRef(false);

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

  /**
   * What Save would send, worked out from the form as it stands. ONE function
   * answers both "is there anything to save?" (the footer's enabled state) and
   * "what does Save send?", so the button can never be live for a save that
   * would then do nothing. Null until the context has loaded; `problem` is a
   * value that cannot be sent as typed.
   */
  function draftEdit(): { patch: Record<string, unknown>; problem: string | null } | null {
    if (!ctx) return null;
    // Send only what CHANGED. A field the barber never touched must not be
    // rewritten - that is how an untouched price silently becomes null.
    const patch: Record<string, unknown> = {};
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
      return { patch, problem: "Pick a valid date and time." };
    }
    const startsAt = zonedWallTimeToUtc(y, m - 1, d, hh * 60 + mm, ctx.timezone);
    if (startsAt.toISOString() !== row.start) patch.startsAt = startsAt.toISOString();
    if (staffId && staffId !== row.staffId) patch.staffId = staffId;
    if (serviceId && serviceId !== row.serviceId) patch.serviceId = serviceId;
    let problem: string | null = null;
    const minutes = duration.trim() === "" ? 0 : Number(duration);
    if (minutes !== spanMinutes(row)) {
      if (Number.isInteger(minutes) && minutes >= DURATION_MIN && minutes <= DURATION_MAX) {
        patch.durationMin = minutes;
      } else {
        problem = `Set a length between ${DURATION_MIN} and ${DURATION_MAX} minutes.`;
      }
    }
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
    return { patch, problem };
  }

  const draft = draftEdit();
  const dirty = draft !== null && (draft.problem !== null || Object.keys(draft.patch).length > 0);
  // Any edit makes the last refusal stale: it was about a form that no longer
  // exists, and leaving it up would blame the new values for the old ones.
  const draftKey = draft ? JSON.stringify(draft) : "";
  useEffect(() => {
    setSaveError(null);
    // A "Book anyway" answered ONE question - this time, this chair, this
    // length. Any edit asks a different one. So did a "Save anyway".
    setOverlapConflict(null);
    acceptedOverlap.current = null;
    setOffHoursConflict(null);
    acceptedCustomTime.current = false;
  }, [draftKey]);

  function save(opts?: { confirmation?: string; overlap?: string }) {
    // The footer passes its click event straight through, so only an actual
    // string is treated as a confirmation.
    const externalBlockConfirmation =
      typeof opts?.confirmation === "string" && opts.confirmation.length > 0
        ? opts.confirmation
        : undefined;
    if (inFlight.current) return;
    if (typeof opts?.overlap === "string" && opts.overlap.length > 0) {
      acceptedOverlap.current = opts.overlap;
    }
    const next = draftEdit();
    if (!next) return;
    if (next.problem) {
      setSaveError(next.problem);
      return;
    }
    const patch = next.patch;
    if (Object.keys(patch).length === 0) {
      setSaveError("Nothing has changed yet.");
      return;
    }
    // Answers the refusal the barber is looking at, and only that one: the
    // server checks this digest against the blocks it finds under the lock, so
    // a banner that has gone stale authorises nothing.
    if (externalBlockConfirmation) patch.externalBlockConfirmation = externalBlockConfirmation;
    // Same for "Book anyway": the digest names the exact bookings he was
    // shown, so anything new in the way is asked about again.
    if (acceptedOverlap.current) patch.overlapConfirmation = acceptedOverlap.current;
    // "Save anyway": skip the usual-openings check for this save. Overlap and
    // blocked time are still checked under the lock, and still asked about.
    if (acceptedCustomTime.current) patch.customTime = true;

    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    start(async () => {
      let res;
      try {
        res = await editAppointmentAction(row.id, patch);
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
      if (!res.ok) {
        if (res.error === "external_block") {
          // Nothing was written. Show which block, keep every field the barber
          // typed, and let him decide - a confirmed retry sends the digest
          // that came back with THIS refusal. A second refusal replaces the
          // banner rather than compounding it.
          setBlockConflict({
            reason: res.reason ?? errorCopy(vocab).external_block!,
            confirmation: res.confirmation ?? "",
          });
          return;
        }
        // The move lands on someone: name them, and offer "Book anyway" behind
        // one more tap on the server's question. A customer's live hold is
        // named with nothing to confirm. Either way the block banner is stale.
        if (res.error === "slot_taken" && (res.code === "OVERLAP" || res.code === "HELD")) {
          setBlockConflict(null);
          setOverlapConflict(
            res.code === "OVERLAP" && res.confirmation
              ? {
                  reason: res.reason ?? "That time overlaps what's already on your calendar:",
                  confirmation: res.confirmation,
                  details: res.conflicts,
                  ask: res.message ?? "This overlaps another booking. Book it anyway?",
                }
              : {
                  reason: res.reason ?? "A customer is booking this time right now. Pick another time.",
                  confirmation: "",
                },
          );
          return;
        }
        // Not a usual opening for this service. That used to be a dead end
        // that also blamed the wrong thing ("outside your hours") - a barber
        // changing a 9:30 twist to a 90-minute braid was refused only because
        // 9:30 isn't one of the braid's usual start times. Offer the override.
        // (If it comes back even with the override sent, that's the answer.)
        if (res.error === "invalid_slot" && !acceptedCustomTime.current) {
          setBlockConflict(null);
          setOverlapConflict(null);
          setOffHoursConflict({ reason: OFF_HOURS_REASON, confirmation: "custom-time" });
          return;
        }
        // Any other refusal is the authoritative answer now - the banners are
        // out of date, so they go and the real error is what he sees. Not a
        // toast: see `saveError`.
        setBlockConflict(null);
        setOverlapConflict(null);
        setOffHoursConflict(null);
        setSaveError(errorCopy(vocab)[res.error ?? ""] ?? "Couldn't save those changes. Try again.");
        return;
      }
      setBlockConflict(null);
      setOverlapConflict(null);
      setOffHoursConflict(null);
      setSaveError(null);
      // Honest about the Acuity half. A move whose block did not confirm is
      // NOT a clean success, and saying so is the whole point of reporting it.
      onSaved(
        res.mirror === "unknown"
          ? { message: "Saved — still confirming the time on Acuity.", tone: "success" }
          : res.mirror === "failed"
            ? {
                message: "Saved here, but Acuity didn't confirm — the old time stays held there.",
                tone: "warning",
              }
            : {
                message: res.status === "PENDING" ? "Saved. Request updated." : "Saved. Appointment updated.",
                tone: "success",
              },
      );
    });
  }

  return {
    ctx,
    loadError,
    pending: pending || saving,
    dirty,
    saveError,
    save,
    blockConflict,
    confirmBlock: () => save({ confirmation: blockConflict?.confirmation }),
    dismissBlock: () => setBlockConflict(null),
    overlapConflict,
    confirmOverlap: () => save({ overlap: overlapConflict?.confirmation }),
    dismissOverlap: () => setOverlapConflict(null),
    offHoursConflict,
    confirmOffHours: () => {
      acceptedCustomTime.current = true;
      save();
    },
    dismissOffHours: () => setOffHoursConflict(null),
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
      duration,
      setDuration,
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
  const vocab = useVocab();
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
    <div className="flex min-w-0 flex-col gap-5">
      {/* First in the body, and it takes focus when it appears: Save lives in
          the sticky footer, so the barber can be scrolled far past this point
          when the refusal comes back. */}
      {state.blockConflict && (
        <ExternalBlockBanner
          conflict={state.blockConflict}
          pending={state.pending}
          confirmLabel="Save over this block"
          pendingLabel="Saving…"
          consequence="Moving it here puts this booking on time you blocked off there. It will be recorded as an override."
          onConfirm={state.confirmBlock}
          onDismiss={state.dismissBlock}
        />
      )}
      {state.overlapConflict && (
        <ExternalBlockBanner
          conflict={state.overlapConflict}
          pending={state.pending}
          confirmLabel="Book anyway"
          pendingLabel="Saving…"
          consequence={
            state.overlapConflict.confirmation
              ? "Both stay on your calendar, and this one is marked Double-booked."
              : "Nothing was changed."
          }
          onConfirm={state.confirmOverlap}
          onDismiss={state.dismissOverlap}
        />
      )}
      {state.offHoursConflict && (
        <ExternalBlockBanner
          conflict={state.offHoursConflict}
          pending={state.pending}
          confirmLabel="Save anyway"
          pendingLabel="Saving…"
          consequence="Those times are for clients booking online. You can still keep this booking as it is - it just can't overlap another booking."
          dismissLabel="Go back"
          onConfirm={state.confirmOffHours}
          onDismiss={state.dismissOffHours}
        />
      )}
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
              if (svc) f.setDuration(String(svc.durationMin));
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

        <Field label={cap(vocab.providerNoun)}>
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

        {/* 🔴 DATE + START: THE PAIR THAT USED TO OVERLAP.
            A native `input[type=date]` has a wide intrinsic min-content width
            (the mm/dd/yyyy text plus the picker button). Tailwind's
            `grid-cols-2` already gives `minmax(0,1fr)` TRACKS, so the tracks
            shrank correctly — but each grid ITEM kept `min-width: auto`, which
            resolves to that intrinsic width. The items therefore overflowed
            their own tracks, ran into each other, and Start spilled past the
            card's right edge.
            `min-w-0` on the Field (below, on the label itself) is the fix.
            The breakpoint is MEASURED, not guessed: a native date control in
            Chromium wants 175px at a 16px font, and the two-up track is 121px
            at 320, 156px at 390 and 171px at 420 — every one of them a
            squeeze. It only stops being one past ~480px, where the track is
            ~200px, so that is where two columns start. The old 380px
            breakpoint compressed the control by up to 54px, which Chromium
            happens to absorb and other engines do not. */}
        <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
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

        <Field label="Duration" hint={`Minutes in the ${vocab.stationNoun}.`}>
          <input
            type="number"
            inputMode="numeric"
            min={DURATION_MIN}
            max={DURATION_MAX}
            step={5}
            value={f.duration}
            onChange={(e) => f.setDuration(e.target.value)}
            placeholder="0"
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

/**
 * Why a time isn't a "usual opening" (invalid_slot). The API can't say which
 * rule it was, so this names every one it might be - the most common for an
 * edit first: a new service steps from opening time by its OWN length, so a
 * time that suited a 75-minute service may not be one of a 90-minute one's.
 */
const OFF_HOURS_REASON =
  "That time isn't one of this service's usual openings. It may be between its usual start times, " +
  "outside your hours or the service's, or inside your booking notice.";

// A function of the shop's words rather than a module constant: two of these
// name the workspace or the provider, and a module-level constant has no
// vocabulary to read.
const errorCopy = (vocab: BusinessVocabulary): Record<string, string> => ({
  // Both of these come back for a LENGTH change as often as a move - a
  // booking stretched into the next one is refused exactly like a booking
  // moved onto it - so neither may talk only about "that time".
  slot_taken: `That runs into another booking on this ${vocab.stationNoun}. Try a shorter length or another time.`,
  // "Book anyway" cleared every overlap, and this is the one rule with no
  // override: two bookings cannot START at the same minute on one chair.
  same_start: "Another appointment starts at exactly that minute. Start this one a few minutes later (e.g. :05).",
  // Normally answered by the "Save anyway" banner (OFF_HOURS_REASON); this is
  // what shows only if it comes back with the override already sent.
  invalid_slot: OFF_HOURS_REASON,
  // Only a FALLBACK: the server names the actual block and window, and that
  // sentence is what the banner shows. This is what it says if a refusal ever
  // arrives without one.
  external_block: "That time is blocked in your external calendar.",
  invalid_phone: "That phone number isn't one we can dial — check the digits.",
  price_change_on_paid:
    "This booking is already paid — refund or take the difference in person first.",
  synced_appointment_readonly: "This one is managed in Acuity.",
  not_editable: "This appointment can no longer be edited.",
  client_not_found: "That client isn't in your book.",
  staff_not_found: `That ${vocab.providerNoun} is no longer available.`,
  service_not_found: "That service is no longer available.",
});
