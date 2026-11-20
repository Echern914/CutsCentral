"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVocab } from "@/components/VocabProvider";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { FormFooter, Group, INPUT, chip } from "../booking/formkit";
import { SpecialChip } from "./SpecialChip";
import { BarberBookSheet } from "./BarberBookSheet";
import { BarberTimeOffSheet } from "./BarberTimeOffSheet";
import {
  cancelOwnAction,
  getOwnDayAction,
  getOwnHoursAction,
  getOwnSlotsAction,
  moveOwnAction,
  saveOwnHoursAction,
  type OwnDay,
  type OwnDayRow,
  type OwnSlot,
} from "./barberCalendarActions";
import { addDays, blockSpanLabel, dayKeyIn, dayLabel, dollars, longDay, timeIn } from "./ownCalendarTime";

/**
 * The weekly-hours editor is the dashboard's own (one editor, one set of
 * rules), pointed at this person's hours. It lives in a very large module, so
 * it is fetched only when "My hours" is tapped.
 */
const StaffHoursSheet = dynamic(
  () => import("../booking/BookingManager").then((m) => m.StaffHoursSheet),
  { ssr: false },
);

type Open =
  | null
  | { kind: "book" }
  | { kind: "hours" }
  | { kind: "timeoff" }
  | { kind: "change"; row: OwnDayRow };

const ACTION =
  "flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-xl border border-subtle px-3 text-sm text-offwhite transition-colors duration-150 ease-out hover:border-subtle-strong";
const STEP =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-subtle text-lg text-offwhite transition-colors duration-150 ease-out hover:border-subtle-strong disabled:opacity-40";

/**
 * A team member's own calendar, one day at a time: step to any day, see their
 * bookings and time off, and from here book a client, move or cancel one of
 * their bookings, set their hours and block time off.
 *
 * Everything shown and everything changed is their own. Which calendar that is
 * comes from their login on the server, so nothing on this screen can be
 * pointed at anybody else.
 */
export function BarberDay({ initial }: { initial: OwnDay }) {
  const vocab = useVocab();
  const [day, setDay] = useState<OwnDay>(initial);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  // Taps on the stepper can outrun the answers; only the latest one is shown.
  const asked = useRef(0);

  const load = useCallback(async (date: string) => {
    const mine = ++asked.current;
    setLoading(true);
    setLoadFailed(false);
    const res = await getOwnDayAction(date);
    if (mine !== asked.current) return;
    setLoading(false);
    if (res.ok && res.data) setDay(res.data);
    else setLoadFailed(true);
  }, []);

  const tz = day.shop.timezone;
  const openRows = day.rows.filter((r) => !r.closed);
  const label = dayLabel(day.date, day.today);
  const clientWord = vocab.clientNoun;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="border-b border-subtle px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous day"
            className={STEP}
            disabled={loading}
            onClick={() => void load(addDays(day.date, -1))}
          >
            <span aria-hidden>‹</span>
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h2 className="truncate font-display text-lg" aria-live="polite">
              {label}
            </h2>
            <p className="truncate text-xs text-muted">
              {label === longDay(day.date) ? "Your day" : longDay(day.date)}
              {" · "}
              {openRows.length === 0
                ? "nothing booked"
                : `${openRows.length} booked`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Next day"
            className={STEP}
            disabled={loading}
            onClick={() => void load(addDays(day.date, 1))}
          >
            <span aria-hidden>›</span>
          </button>
        </div>
        {day.date !== day.today && (
          <button
            type="button"
            className="mx-auto mt-2 flex min-h-[44px] items-center px-3 text-sm text-gold hover:underline"
            onClick={() => void load(day.today)}
          >
            Back to today
          </button>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {day.canBook && (
            <button
              type="button"
              className="flex min-h-[44px] min-w-0 flex-1 basis-full items-center justify-center rounded-xl bg-primary px-3 text-sm font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90 sm:basis-0"
              onClick={() => setOpen({ kind: "book" })}
            >
              Book a {clientWord}
            </button>
          )}
          <button type="button" className={ACTION} onClick={() => setOpen({ kind: "timeoff" })}>
            Time off
          </button>
          <button type="button" className={ACTION} onClick={() => setOpen({ kind: "hours" })}>
            My hours
          </button>
        </div>
      </div>

      {loadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-subtle px-4 py-3 sm:px-5">
          <p className="min-w-0 flex-1 text-sm text-danger-soft">
            Couldn&rsquo;t load that day. Showing {dayLabel(day.date, day.today).toLowerCase()} instead.
          </p>
          <button
            type="button"
            className="flex min-h-[44px] items-center rounded-xl border border-subtle px-4 text-sm text-offwhite"
            onClick={() => void load(day.date)}
          >
            Try again
          </button>
        </div>
      )}

      <div className={loading ? "opacity-60" : undefined} aria-busy={loading}>
        {day.blocks.length > 0 && (
          <ul className="divide-y divide-subtle border-b border-subtle">
            {day.blocks.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <span aria-hidden className="h-8 w-1 shrink-0 rounded-full bg-muted/50" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-offwhite">
                    Time off · {blockSpanLabel(b, day.date, tz)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {b.reason || "No bookings in this time"}
                    {b.shared && " · set by the shop"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {day.rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            {day.date === day.today ? "Nothing booked today. Enjoy the quiet." : "Nothing booked this day."}
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {day.rows.map((r) => (
              <li
                key={r.id}
                className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${r.closed ? "opacity-50" : ""}`}
              >
                <span
                  aria-hidden
                  className="h-8 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: r.color ?? "#3F3F46" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-offwhite">
                      {timeIn(tz, r.startsAt)} · {r.clientName || "Client"}
                    </p>
                    {r.special && <SpecialChip afterHours={r.afterHours} premium={r.premium} />}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {r.service}
                    {r.closed && ` · ${r.status.toLowerCase().replace("_", " ")}`}
                    {!r.closed && r.runningLate && " · running late"}
                    {!r.closed && !r.runningLate && r.checkInStatus === "ON_MY_WAY" && " · on the way"}
                    {!r.closed && !r.runningLate && r.checkInStatus === "ARRIVED" && " · here"}
                  </p>
                </div>
                {day.canBook && r.canChange && (
                  <button
                    type="button"
                    className="flex min-h-[44px] shrink-0 items-center rounded-xl border border-subtle px-3 text-sm text-offwhite transition-colors duration-150 ease-out hover:border-subtle-strong"
                    aria-label={`Change ${r.clientName || "this booking"} at ${timeIn(tz, r.startsAt)}`}
                    onClick={() => setOpen({ kind: "change", row: r })}
                  >
                    Change
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {open?.kind === "book" && (
        <BarberBookSheet
          timezone={tz}
          startDay={day.date < day.today ? day.today : day.date}
          today={day.today}
          onClose={() => setOpen(null)}
          onBooked={(bookedDay) => void load(bookedDay)}
        />
      )}
      {open?.kind === "timeoff" && (
        <BarberTimeOffSheet
          timezone={tz}
          startDay={day.date < day.today ? day.today : day.date}
          today={day.today}
          onClose={() => setOpen(null)}
          onChanged={() => void load(day.date)}
        />
      )}
      {open?.kind === "hours" && (
        <StaffHoursSheet
          staffId="own"
          staffName="Your"
          own={{ load: getOwnHoursAction, save: saveOwnHoursAction }}
          toast={() => {}}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "change" && (
        <ChangeSheet
          row={open.row}
          timezone={tz}
          today={day.today}
          onClose={() => setOpen(null)}
          onChanged={(shownDay) => void load(shownDay)}
        />
      )}
    </Card>
  );
}

/** What a refused move or cancel says, in words the person can act on. */
function changeProblem(code: string | undefined, what: "move" | "cancel"): string {
  switch (code) {
    case "slot_taken":
    case "invalid_slot":
    case "slot_unavailable_external":
      return "That time was just taken. Pick another one.";
    case "not_found":
      return "This booking isn't on your calendar any more. Close this and check your day.";
    case "external_block":
      return "That time is blocked on the shop's other calendar. Pick another one.";
    case "not_cancellable":
    case "not_reschedulable":
    case "not_booked":
      return "This booking can't be changed from here any more.";
    case "tip_paid":
    case "tip_in_progress":
      return "A tip is attached to this visit, so the shop owner has to cancel it.";
    case "price_changed":
      return "That time has a different price and this booking is already paid. Ask the shop owner to move it.";
    case "offer_refused":
      return "This booking used an offer that doesn't apply at that time. Pick another one.";
    case "network_error":
      return "Couldn't reach the server. Close this and check your day before trying again.";
    default:
      return what === "move"
        ? "Couldn't move it. Nothing changed. Try again."
        : "Couldn't cancel it. Nothing changed. Try again.";
  }
}

/**
 * One of their own bookings: move it to another open time, or cancel it. The
 * outcome is read in the dialog's footer, where it cannot be missed.
 */
function ChangeSheet({
  row,
  timezone,
  today,
  onClose,
  onChanged,
}: {
  row: OwnDayRow;
  timezone: string;
  today: string;
  onClose: () => void;
  /** Called with the day the calendar should now show. */
  onChanged: (day: string) => void;
}) {
  const rowDay = dayKeyIn(timezone, row.startsAt);
  const [mode, setMode] = useState<"move" | "cancel">("move");
  const [date, setDate] = useState(rowDay);
  const [slots, setSlots] = useState<OwnSlot[] | null>(null);
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [price, setPrice] = useState<{ fromCents: number; toCents: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const asked = useRef(0);
  const who = row.clientName || "This booking";

  const loadSlots = useCallback(
    async (d: string) => {
      const mine = ++asked.current;
      setSlots(null);
      setSlotsFailed(false);
      setPicked(null);
      setPrice(null);
      const res = await getOwnSlotsAction({ date: d, appointmentId: row.id });
      if (mine !== asked.current) return;
      if (res.ok && res.data) {
        // Its own current time is "no change", so it is not offered.
        setSlots(res.data.slots.filter((s) => s.startsAt !== row.startsAt));
      } else {
        setSlotsFailed(true);
      }
    },
    [row.id, row.startsAt],
  );

  useEffect(() => {
    if (mode === "move" && !done) void loadSlots(date);
  }, [mode, date, done, loadSlots]);

  async function move() {
    if (!picked || pending) return;
    setPending(true);
    setProblem(null);
    const res = await moveOwnAction(row.id, picked, price?.toCents);
    setPending(false);
    if (res.ok) {
      setDone(`Moved to ${longDay(date)} at ${timeIn(timezone, picked)}.`);
      onChanged(date);
      return;
    }
    if (res.error === "price_changes" && res.fromCents !== undefined && res.toCents !== undefined) {
      setPrice({ fromCents: res.fromCents, toCents: res.toCents });
      return;
    }
    setPrice(null);
    setProblem(changeProblem(res.error, "move"));
    if (res.error === "slot_taken" || res.error === "invalid_slot") void loadSlots(date);
  }

  async function cancel() {
    if (pending) return;
    setPending(true);
    setProblem(null);
    const res = await cancelOwnAction(row.id);
    setPending(false);
    if (res.ok) {
      setDone("Cancelled.");
      onChanged(rowDay);
      return;
    }
    setProblem(changeProblem(res.error, "cancel"));
  }

  const footer = done ? (
    <div className="flex w-full flex-col gap-2">
      <p role="status" className="text-sm text-offwhite">
        {done}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="flex h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary"
      >
        Done
      </button>
    </div>
  ) : mode === "move" ? (
    <FormFooter
      error={problem}
      label={
        price
          ? `Move it at ${dollars(price.toCents)}`
          : picked
            ? `Move to ${timeIn(timezone, picked)}`
            : "Pick a time"
      }
      pendingLabel="Moving…"
      pending={pending}
      disabled={!picked}
      onSubmit={() => void move()}
    />
  ) : (
    <div className="flex w-full flex-col gap-2">
      {problem && (
        <p role="alert" className="text-sm text-danger-soft">
          {problem}
        </p>
      )}
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={pending}
        className="flex h-11 w-full items-center justify-center rounded-xl border border-danger-soft/50 px-5 text-sm font-semibold text-danger-soft disabled:opacity-50"
      >
        {pending ? "Cancelling…" : "Cancel this booking"}
      </button>
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={who}
      subtitle={`${longDay(rowDay)} at ${timeIn(timezone, row.startsAt)} · ${row.service}`}
      footer={footer}
      className="sm:max-w-md"
    >
      {!done && (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="What to do">
            <button
              type="button"
              aria-pressed={mode === "move"}
              className={chip(mode === "move")}
              onClick={() => {
                setMode("move");
                setProblem(null);
              }}
            >
              Move it
            </button>
            <button
              type="button"
              aria-pressed={mode === "cancel"}
              className={chip(mode === "cancel")}
              onClick={() => {
                setMode("cancel");
                setProblem(null);
              }}
            >
              Cancel it
            </button>
          </div>

          {mode === "move" ? (
            <Group title="New time">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Day</span>
                <input
                  type="date"
                  className={INPUT}
                  value={date}
                  min={today}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              </label>
              {slotsFailed ? (
                <div role="alert" className="flex flex-col items-start gap-2">
                  <p className="text-sm text-danger-soft">Couldn&rsquo;t load the open times.</p>
                  <button
                    type="button"
                    className="flex min-h-[44px] items-center rounded-xl border border-subtle px-4 text-sm text-offwhite"
                    onClick={() => void loadSlots(date)}
                  >
                    Try again
                  </button>
                </div>
              ) : slots === null ? (
                <p className="text-sm text-muted">Loading open times…</p>
              ) : slots.length === 0 ? (
                <p className="text-sm text-muted">No other open times on {longDay(date)}. Try another day.</p>
              ) : (
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="Open times">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      type="button"
                      aria-pressed={picked === s.startsAt}
                      className={chip(picked === s.startsAt)}
                      onClick={() => {
                        setPicked(s.startsAt);
                        setPrice(null);
                        setProblem(null);
                      }}
                    >
                      {timeIn(timezone, s.startsAt)}
                    </button>
                  ))}
                </div>
              )}
              {price && (
                <p role="alert" className="text-sm text-offwhite">
                  The price at that time is {dollars(price.toCents)}, not {dollars(price.fromCents)}. Tap
                  below to move it at the new price, or pick another time.
                </p>
              )}
            </Group>
          ) : (
            <p className="text-sm leading-relaxed text-muted">
              {who === "This booking" ? "They are" : `${who} is`} told it&rsquo;s cancelled, and the time
              opens up again. Anything paid to book it follows the shop&rsquo;s usual rules.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
