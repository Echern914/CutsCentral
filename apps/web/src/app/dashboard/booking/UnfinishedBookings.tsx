"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { mailtoUri, smsUri, telUri } from "@/lib/contactUri";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import { BTN_BASE, NAME_WRAP_CLS } from "../_components/appointmentCardStyles";
import { createAppointmentAction, type CreateApptResult } from "./actions";
import { Chevron } from "./TargetedSlotCard";
import { inviteUnfinishedAction } from "./unfinishedActions";
import {
  dismissUnfinishedAction,
  listUnfinishedAction,
  type UnfinishedReason,
  type UnfinishedRow,
} from "./unfinishedActions";

/**
 * "DIDN'T FINISH BOOKING" - above the calendar, only when there is someone on
 * it.
 *
 * A client picked a time and pressed Confirm but never finished the card step,
 * so the hold ran out and the time went back on sale. They may think they are
 * booked. The shop could not see who they were; this shows who, the time they
 * wanted, whether it is still free, and the three things to do about it: text
 * or call them, book them into that time, or take them off the list.
 *
 * 🔴 BOOK THEM IS THE ORDINARY DASHBOARD BOOKING (createAppointmentAction),
 * with every guard it has, plus `confirmClient`: unlike a booking made at the
 * chair, ChairBack emails these clients their confirmation (and pushes the app),
 * because they tried to book online and the barber can't text everyone. The
 * row then says whether an email really went out. It asks first, because it
 * creates a booking. It never forces anything: outside the open hours it asks
 * again, and a time someone else has taken is refused, never booked over.
 *
 * A TIME SOMEONE ELSE TOOK can't be booked; "Email them to pick a new time"
 * sends that client one email (once) with the booking page.
 *
 * 🔴 A BOOKING MADE HERE STAYS ON SCREEN until "Done": when no email could go
 * out, the one thing left to do - text them that it's set - needs the row.
 */

type Toast = (msg: string, kind?: "success" | "error") => void;

/** Long enough not to matter to the server; short enough that a live hold turns over. */
const POLL_MS = 60_000;
/** Rows shown before "Show all". */
const COLLAPSED = 3;

const REASON: Record<UnfinishedReason, string> = {
  card_not_saved: "Didn't save a card",
  card_saved_late: "Saved a card after the hold ran out",
  not_paid: "Didn't pay",
  paid_late_refunded: "Paid after the hold ran out, and was refunded",
  paid_late: "Paid after the hold ran out, and the refund isn't finished",
  not_finished: "Didn't finish",
};

/**
 * What a refused booking says, by why it was refused. `sticky` = it stays for
 * as long as this screen does: the list's own "still free?" read can't see
 * everything the booking guard does (the turnover buffer, an unbooked special,
 * the other calendar), so a fresh read saying "Time open" must not re-offer a
 * tap that will be refused again. A live hold is the one refusal that clears
 * itself (it runs out within ten minutes), so it lasts only until the next
 * read.
 */
interface Refusal {
  note: string;
  chip: "taken" | "blocked" | null;
  sticky: boolean;
}

function refusalFor(error: string | undefined, code: string | undefined): Refusal | null {
  switch (error) {
    case "slot_taken":
      return code === "HELD"
        ? {
            // Often it's them: the shop texted them and they went back to book.
            note: "Someone is on the card step for that time right now. It may be them. Check again in a few minutes.",
            chip: "taken",
            sticky: false,
          }
        : { note: "That time was just taken. Text them to pick another.", chip: "taken", sticky: true };
    case "same_start":
      return { note: "That time was just taken. Text them to pick another.", chip: "taken", sticky: true };
    case "external_block":
      return { note: "That time is blocked on your other calendar.", chip: "blocked", sticky: true };
    case "acuity_refused":
      return { note: "Your other calendar wouldn't take that time.", chip: "blocked", sticky: true };
    case "slot_unavailable_external":
      return {
        note: "This calendar isn't linked to your other calendar yet, so it can't be booked from here.",
        chip: null,
        sticky: true,
      };
    default:
      return null;
  }
}

interface Formatters {
  when: Intl.DateTimeFormat;
  tried: Intl.DateTimeFormat;
  clock: Intl.DateTimeFormat;
}

function formatters(timeZone: string): Formatters {
  return {
    when: new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    tried: new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    clock: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }),
  };
}

export function UnfinishedBookings({ isNative, toast }: { isNative: boolean; toast: Toast }) {
  const [timezone, setTimezone] = useState<string | null>(null);
  const [rows, setRows] = useState<UnfinishedRow[]>([]);
  const [more, setMore] = useState(0);
  // Booked from here: kept on screen until "Done" (see the header).
  const [booked, setBooked] = useState<Map<string, UnfinishedRow>>(() => new Map());
  // Whether each booking made here emailed the client its confirmation. Kept
  // here, not in the card: a card that scrolls out of the collapsed list and
  // back must still say what really happened.
  const [told, setTold] = useState<Map<string, "email" | "none" | null>>(() => new Map());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  // Counts successful reads, so a card can tell "fresh data since my refusal".
  const [readCount, setReadCount] = useState(0);

  const load = useCallback(async () => {
    const res = await listUnfinishedAction();
    // A failed read changes nothing: this panel is extra, the calendar is not.
    if (!res.ok || !res.data) return;
    setTimezone(res.data.timezone);
    setRows(res.data.rows);
    setMore(res.data.more);
    setReadCount((n) => n + 1);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // A live hold turns into a lapsed one (or a booking) within ten minutes.
  useVisiblePoll(load, POLL_MS);

  const fmt = useMemo(() => (timezone ? formatters(timezone) : null), [timezone]);

  const shown = useMemo(() => {
    const byId = new Map<string, UnfinishedRow>();
    for (const r of rows) if (!hidden.has(r.id)) byId.set(r.id, r);
    for (const [id, r] of booked) byId.set(id, r);
    return [...byId.values()].sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id),
    );
  }, [rows, booked, hidden]);

  if (!fmt || shown.length === 0) return null;

  const visible = expanded ? shown : shown.slice(0, COLLAPSED);
  const waiting = shown.filter((r) => !booked.has(r.id)).length;

  async function dismiss(row: UnfinishedRow) {
    setHidden((prev) => new Set(prev).add(row.id));
    const res = await dismissUnfinishedAction(row.id);
    if (res.ok) {
      toast("Taken off the list", "success");
      return;
    }
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    toast(
      res.error === "still_finishing"
        ? "They're still booking. Try again once their hold runs out."
        : "Couldn't take them off the list",
      "error",
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <section aria-labelledby="unfinished-bookings-title" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="unfinished-bookings-title" className="font-display text-lg">
            Didn&apos;t finish booking
            {waiting > 0 && (
              <span className="ml-2 rounded-full bg-amber-400/20 px-2 py-0.5 align-middle text-[11px] font-semibold text-amber-300">
                {waiting + more}
              </span>
            )}
          </h2>
        </div>
        <p className="text-xs text-muted">
          They picked a time but didn&apos;t finish, so they aren&apos;t booked. They may think they are.
        </p>
        <ul className="flex flex-col gap-2">
          {visible.map((row) => (
            <UnfinishedCard
              key={row.id}
              row={row}
              readCount={readCount}
              fmt={fmt}
              isNative={isNative}
              booked={booked.has(row.id)}
              told={told.get(row.id) ?? null}
              toast={toast}
              onBooked={(outcome) => {
                setTold((prev) => new Map(prev).set(row.id, outcome));
                setBooked((prev) => new Map(prev).set(row.id, row));
                // Anyone else who wanted that same time has just lost it.
                void load();
              }}
              onDone={() => {
                setBooked((prev) => {
                  const next = new Map(prev);
                  next.delete(row.id);
                  return next;
                });
                setHidden((prev) => new Set(prev).add(row.id));
              }}
              onDismiss={() => void dismiss(row)}
            />
          ))}
        </ul>
        {!expanded && shown.length > COLLAPSED && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="self-start text-xs font-medium text-gold hover:underline"
          >
            Show all {shown.length}
          </button>
        )}
        {more > 0 && (
          <p className="text-[11px] text-muted/80">
            {more} more not shown. Take some off the list to see them.
          </p>
        )}
      </section>
    </Card>
  );
}

type Step = "idle" | "confirm" | "outside_hours" | "working";

function UnfinishedCard({
  row,
  readCount,
  fmt,
  isNative,
  booked,
  told,
  toast,
  onBooked,
  onDone,
  onDismiss,
}: {
  row: UnfinishedRow;
  /** How many times the list has been read; a new read replaces a refusal. */
  readCount: number;
  fmt: Formatters;
  isNative: boolean;
  booked: boolean;
  /** Booked here: whether ChairBack emailed them their confirmation. Null = an older API. */
  told: "email" | "none" | null;
  toast: Toast;
  onBooked: (told: "email" | "none" | null) => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const vocab = useVocab();
  const [step, setStep] = useState<Step>("idle");
  const [note, setNote] = useState<string | null>(null);
  // A refused booking (see refusalFor): sticky ones stay, a live-hold one only
  // until the next read - it belongs to the read it landed in.
  const [refusal, setRefusal] = useState<(Refusal & { readCount: number }) | null>(null);
  // The read current when a refusal LANDS, not when the tap started - a poll
  // can arrive while the booking request is out.
  const latestRead = useRef(readCount);
  latestRead.current = readCount;
  // "Email them to pick a new time": when it went - from this tap, or from the
  // latest read (another phone may have sent it). `invitedKnown` is false when
  // the server knows it went but not when.
  const [invitedHere, setInvitedHere] = useState<string | null>(null);
  const [invitedNoTime, setInvitedNoTime] = useState(false);
  // The send's answer was lost: it may have gone out, so it isn't offered again.
  const [inviteUnknown, setInviteUnknown] = useState(false);
  const invitedAt = invitedHere ?? row.invitedAt ?? null;
  const invited = invitedAt !== null || invitedNoTime;
  const [inviting, setInviting] = useState(false);
  // Collapsed until tapped. A row with something to say stays open: a booking
  // that still needs "Done", a question it asked, or why a tap was refused.
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const name =`${row.firstName} ${row.lastName ?? ""}`.trim() || cap(vocab.clientNoun);
  const first = row.firstName.trim() || name;
  const when = fmt.when.format(new Date(row.startsAt));
  const live = row.state === "live";
  const refused = refusal !== null && (refusal.sticky || refusal.readCount === readCount) ? refusal : null;
  const isOpen = open || booked || step !== "idle" || refused !== null || note !== null;
  const taken = row.timeTaken || refused?.chip === "taken";
  const blocked = !taken && (row.blockedElsewhere || refused?.chip === "blocked");
  // They wanted a special that isn't on offer now: a plain booking would be
  // the menu service at the menu price, not what they picked. (While they are
  // still on the card step the special is theirs - nothing is gone.)
  const specialGone = !live && row.wantedSpecial && row.targetedSlotId === null;
  const sms = row.canText ? smsUri(row.phone) : null;
  const tel = telUri(row.phone);
  const mail = mailtoUri(row.email);
  const canBook =
    !booked &&
    !live &&
    !taken &&
    !blocked &&
    refused === null &&
    !row.releasing &&
    !specialGone &&
    // Someone else's profile (a shared phone or email): booking here would put
    // it under their name and their saved card.
    row.profileName === null &&
    isNative &&
    row.clientId !== null &&
    !row.repeating;

  const chip = booked
    ? { label: "Booked", cls: "bg-gold/15 text-gold" }
    : live
      ? { label: "Booking now", cls: "bg-sky-400/15 text-sky-300" }
      : taken
        ? { label: "Time taken", cls: "bg-amber-400/15 text-amber-300" }
        : blocked
          ? { label: "Blocked", cls: "bg-charcoal-700 text-muted" }
          : { label: "Time open", cls: "bg-emerald-soft/15 text-emerald-soft" };

  async function invite() {
    if (inviting) return;
    setInviting(true);
    setNote(null);
    const res: { ok: boolean; invitedAt?: string | null; error?: string } = await inviteUnfinishedAction(row.id).catch(
      () => ({ ok: false, error: "network_error" }),
    );
    setInviting(false);
    if (res.ok && res.invitedAt) {
      setInvitedHere(res.invitedAt);
      return;
    }
    const error = res.error;
    if (error === "already_invited") {
      // Sent before (another phone, an earlier tap): say when if the server knows.
      if (res.invitedAt) setInvitedHere(res.invitedAt);
      else setInvitedNoTime(true);
      return;
    }
    if (error === "unknown" || error === "network_error") {
      // The answer was lost: it may have gone out, and it can't go twice.
      setInviteUnknown(error === "unknown");
      setNote(
        error === "unknown"
          ? `We couldn't confirm the email reached ${first}. It may have gone out - check with them before sending anything else.`
          : "Couldn't reach ChairBack. Try again - it won't send twice.",
      );
      return;
    }
    setNote(
      error === "unsubscribed"
        ? `${first} unsubscribed from your emails. Text or call them instead.`
        : error === "no_email"
          ? `There's no email for ${first}. Text or call them instead.`
          : error === "blocked"
            ? `You've blocked ${first} from booking, so there's nothing to invite them to.`
            : error === "paid"
              ? `${first} paid. Text or call them about it rather than send this.`
              : error === "repeating"
                ? "They wanted a repeating booking. Text or call them to set that up."
                : error === "stale"
                  ? "That's changed since this list loaded. Nothing was sent."
                  : error === "no_booking_page"
                    ? "Your booking page is off, so there's nowhere to send them."
                    : error === "email_unavailable"
                      ? "Email isn't available right now. Nothing was sent."
                      : "Couldn't send it. Nothing was sent - try again.",
    );
  }

  async function book(customTime: boolean) {
    setStep("working");
    setNote(null);
    setRefusal(null);
    const send = (withEmail: boolean, confirm = true) =>
      createAppointmentAction({
        staffId: row.staffId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        clientId: row.clientId!,
        // They tried to book online and may think they are: tell them.
        ...(confirm ? { confirmClient: true as const } : {}),
        // What THEY typed, so the booking reaches them, not whatever the
        // profile holds.
        ...(row.phone ? { phone: row.phone } : {}),
        ...(withEmail && row.email ? { email: row.email } : {}),
        // A special they tried for is booked AS the special (its own length
        // and price); otherwise the add-ons they picked come with the time.
        ...(row.targetedSlotId
          ? { targetedSlotId: row.targetedSlotId }
          : row.addOns.length > 0
            ? { addOnIds: row.addOns.map((a) => a.id) }
            : {}),
        ...(customTime ? { customTime: true } : {}),
      });
    let res: CreateApptResult = await send(true);
    // The booking page accepts some addresses the dashboard's stricter check
    // refuses. A 400 books nothing, so try once more without it: reminders
    // (and the confirmation) then use the email on their profile.
    if (!res.ok && res.error === "invalid_input" && row.email) res = await send(false);
    // An API that predates the confirmation refuses the unknown field the same
    // way: book them as before rather than not at all - keeping what they
    // typed, and dropping it only if that is refused too.
    if (!res.ok && res.error === "invalid_input" && row.email) res = await send(true, false);
    if (!res.ok && res.error === "invalid_input") res = await send(false, false);
    if (res.ok) {
      setStep("idle");
      toast(`Booked ${first}`, "success");
      onBooked(res.clientConfirmation ?? null);
      return;
    }
    if (res.error === "invalid_slot" && !customTime && !row.targetedSlotId) {
      // Off the calendar now: outside the hours, blocked off, too soon, the
      // day full. The shop may still want it - ask, never assume.
      setStep("outside_hours");
      return;
    }
    setStep("idle");
    const why = refusalFor(res.error, res.code);
    if (why) {
      setRefusal({ ...why, readCount: latestRead.current });
      return;
    }
    setNote(
      res.error === "invalid_add_on"
        ? "An add-on they picked isn't offered anymore. Book them from New appointment."
        : res.error === "client_not_found"
          ? `Their ${vocab.clientNoun} profile is gone. Book them from New appointment.`
          : res.error === "invalid_slot"
            ? // Refused even as a custom time: the service or provider itself.
              "That service or provider isn't available at that time anymore."
            : "Couldn't book them. Try New appointment.",
    );
  }

  return (
    <li
      className={cn(
        "min-w-0 rounded-xl border bg-charcoal-800/60",
        isOpen ? "border-gold/40" : "border-subtle",
      )}
    >
      {/* Collapsed, a row is who and when - two lines, so a list of five fits
          above the calendar on a phone. Everything else is one tap away. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full min-w-0 flex-col gap-0.5 px-3.5 py-2.5 text-left"
      >
        {/* The chip and arrow ride on the NAME line, so the time line below
            gets the full width and stays one line on a phone. */}
        <span className="flex min-w-0 items-start gap-2">
          <span className={cn(NAME_WRAP_CLS, "flex-1 text-[15px]")}>{name}</span>
          <span className={cn("mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold", chip.cls)}>
            {chip.label}
          </span>
          <Chevron open={isOpen} />
        </span>
        <span className="text-xs text-muted [overflow-wrap:anywhere]">
          <span className="font-medium text-offwhite/90">Wanted {when}</span>
          {" · "}
          {row.serviceName}
          {row.addOns.length > 0 && ` + ${row.addOns.map((a) => a.name).join(", ")}`}
          {" · "}
          {row.staffName}
        </span>
      </button>

      {isOpen && (
        <div id={panelId} className="min-w-0 px-3.5 pb-3">
          <div className="flex min-w-0 flex-col gap-1 text-xs text-muted">
            {booked ? (
              <p className="text-gold" role="status">
                {told === "email"
                  ? `Booked for ${when}. ChairBack emailed ${first} a confirmation.`
                  : told === "none"
                    ? `Booked for ${when}. ChairBack couldn't email ${first} a confirmation, so text them it's set.`
                    : `Booked for ${when}. ChairBack doesn't send a confirmation, so text them it's set.`}
              </p>
            ) : live ? (
              <p>
                On the card step now. Held until {fmt.clock.format(new Date(row.heldUntil ?? row.startsAt))}.
              </p>
            ) : (
              <p>
                {row.reason ? REASON[row.reason] : "Didn't finish"}. Tried {fmt.tried.format(new Date(row.triedAt))}
                {row.attempts > 1 ? ` · ${row.attempts} tries` : ""}.
              </p>
            )}
            {row.otherTimes.length > 0 && !booked && (
              <p className="[overflow-wrap:anywhere]">
                Also tried: {row.otherTimes.map((t) => fmt.when.format(new Date(t.startsAt))).join("; ")}
              </p>
            )}
            {row.releasing && !booked && (
              <p>Their hold just ran out. You can book them here in a few minutes.</p>
            )}
            {row.repeating && !booked && (
              <p>Wanted it as a repeating booking. Set that up from New appointment.</p>
            )}
            {specialGone && !taken && !blocked && !row.releasing && !booked && (
              <p>They wanted one of your specials, which isn&apos;t on offer at that time now.</p>
            )}
            {row.blockedElsewhere && !taken && !booked && !refused && (
              <p>That time is blocked on your other calendar.</p>
            )}
            {row.profileName && !booked && (
              <p className="[overflow-wrap:anywhere]">
                Uses the same number or email as {row.profileName}, so booking them here would put it
                under {row.profileName}&apos;s name. If it&apos;s the same person, book them from New
                appointment.
              </p>
            )}
            {(row.phone || row.email) && (
              <p className="break-words">
                {row.phone &&
                  (sms ? (
                    <a href={sms} className="text-gold hover:underline">
                      {row.phoneDisplay ?? row.phone}
                    </a>
                  ) : (
                    <span className="text-offwhite/75">{row.phoneDisplay ?? row.phone}</span>
                  ))}
                {row.phone && row.email && <span> · </span>}
                {row.email &&
                  (mail ? (
                    <a href={mail} className="text-gold hover:underline [overflow-wrap:anywhere]">
                      {row.email}
                    </a>
                  ) : (
                    <span className="text-offwhite/75 [overflow-wrap:anywhere]">{row.email}</span>
                  ))}
              </p>
            )}
            {(refused?.note ?? note) && (
              <p role="status" className="text-amber-300">
                {refused?.note ?? note}
              </p>
            )}
            {invited && !booked && (
              <p role="status" className="text-emerald-soft">
                Emailed {first} to pick a new time
                {invitedAt ? ` (${fmt.tried.format(new Date(invitedAt))})` : ""}.
              </p>
            )}
          </div>

          {step === "confirm" || step === "outside_hours" ? (
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-gold/30 bg-gold/5 p-3">
              <p className="text-xs text-offwhite">
                {step === "confirm"
                  ? `Book ${first} for ${when}? ChairBack emails them a confirmation if it has an email for them.`
                  : "That time isn't open on your calendar now (for example it's outside your hours, blocked off, too soon, or the day is full). Book it anyway?"}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void book(step === "outside_hours")}
                  className={cn(BTN_BASE, "bg-gold font-semibold text-charcoal-900 hover:bg-gold/90")}
                >
                  {step === "confirm" ? "Book" : "Book anyway"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep("idle")}
                  className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            // Text, Call and Dismiss share ONE row on a phone; the action that
            // books or emails gets a row of its own above them.
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {canBook && (
                <button
                  type="button"
                  onClick={() => setStep("confirm")}
                  disabled={step === "working"}
                  className={cn(BTN_BASE, "col-span-3 bg-gold font-semibold text-charcoal-900 hover:bg-gold/90 sm:col-span-1")}
                >
                  {step === "working" ? "Booking…" : "Book them"}
                </button>
              )}
              {/* Someone else booked their time: one email with the booking page,
                  once. The server decides it may be offered (canInvite). */}
              {!booked && !live && row.canInvite && !invited && !inviteUnknown && (
                <button
                  type="button"
                  onClick={() => void invite()}
                  disabled={inviting}
                  className={cn(
                    BTN_BASE,
                    "col-span-3 border border-gold/50 font-semibold text-gold hover:bg-gold/10 sm:col-span-2",
                  )}
                >
                  {inviting ? "Sending…" : "Email them to pick a new time"}
                </button>
              )}
              {sms && (
                <a
                  href={sms}
                  className={cn(BTN_BASE, "border border-gold/50 font-semibold text-gold hover:bg-gold/10")}
                >
                  Text
                </a>
              )}
              {tel && (
                <a href={tel} className={cn(BTN_BASE, "border border-subtle text-offwhite/90 hover:bg-charcoal-700")}>
                  Call
                </a>
              )}
              {booked ? (
                <button
                  type="button"
                  onClick={onDone}
                  className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
                >
                  Done
                </button>
              ) : (
                !live && (
                  <button
                    type="button"
                    onClick={onDismiss}
                    disabled={step === "working"}
                    className={cn(BTN_BASE, "border border-subtle text-muted hover:text-offwhite")}
                  >
                    Dismiss
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
