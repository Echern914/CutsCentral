"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import type { StaffRow } from "./page";
import { addBlockAction, type BlockOffInput } from "./actions";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";
import {
  blockSummary,
  dayCount,
  isDayKey,
  MAX_BLOCK_DAYS,
  minutesOf,
  type BlockPlan,
} from "./blockOffDates";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "Block off time" (native), in the SAME chrome as the appointment sheet:
 * ui/Dialog shell, formkit cards. Blocks time on a provider's calendar so no
 * one can book it. Reuses the staff-exceptions endpoint.
 *
 * Three shapes, one form:
 *   - a timed block on one day (From / To, converted through the SHOP's zone);
 *   - all of one day;
 *   - every day from a start date through an end date, all day each.
 * The whole-day shapes send DAY KEYS and let the API resolve every midnight in
 * the shop's zone itself - "all of September 9" is a statement about a
 * calendar day, and the API is the one place that knows the zone for certain.
 * The timed shape converts here exactly as the appointment form does.
 *
 * `dayKey` (YYYY-MM-DD, shop tz) is the day tapped in the calendar and is the
 * default; any future day can be picked without leaving the sheet. A block
 * over existing bookings comes back as a refusal the barber can answer (see
 * ExternalBlockBanner) - the bookings are never touched either way.
 */
export function BlockOffForm({
  staff,
  dayKey,
  todayKey,
  timezone,
  defaultFromHour,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  dayKey: string; // YYYY-MM-DD, shop tz - the day tapped in the calendar
  todayKey: string; // YYYY-MM-DD, shop tz - the earliest day worth blocking
  timezone: string; // IANA shop tz - the time inputs are shop wall clock
  defaultFromHour: number; // 0-23, the tapped hour
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const activeStaff = staff.filter((s) => s.active);
  const [staffId, setStaffId] = useState<string | null>(
    activeStaff.length === 1 ? activeStaff[0]!.id : null,
  );
  // The calendar's day, unless it has already passed - a block on a day that
  // is gone does nothing, so the form starts on the first day it could matter.
  const initialDate = dayKey < todayKey ? todayKey : dayKey;
  const [date, setDate] = useState(initialDate);
  const [multiDay, setMultiDay] = useState(false);
  const [endDate, setEndDate] = useState(initialDate);
  const [fromTime, setFromTime] = useState(pad(defaultFromHour) + ":00");
  const [toTime, setToTime] = useState(pad(Math.min(23, defaultFromHour + 1)) + ":00");
  // Whole-day switch: testers blocking a vacation were hand-typing 00:00-23:00
  // per day, which leaves 23:00-midnight open - a real slot for late-hours
  // shops. All day = local midnight to next-midnight, DST-exact (the API does
  // that arithmetic from the day key).
  const [allDay, setAllDay] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BlockConflict | null>(null);
  // Own flag, not useTransition's: isPending does not span the await inside
  // an async transition, so "Blocking…" would flicker off before the request
  // had gone anywhere. The ref refuses a second submit inside one handler.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // A range is always sent as days (all day on each, or the same hours on
  // each); a single day sends instants unless it is all day.
  const plan: BlockPlan = multiDay
    ? {
        kind: "days",
        fromDate: date,
        toDate: endDate,
        ...(allDay ? {} : { window: { fromTime, toTime } }),
      }
    : allDay
      ? { kind: "days", fromDate: date, toDate: date }
      : { kind: "timed", date, fromTime, toTime };
  const summary = blockSummary(plan, todayKey);
  const days = plan.kind === "days" ? dayCount(plan.fromDate, plan.toDate) : 1;

  function onDateChange(next: string) {
    setDate(next);
    // The end never trails the start; nudging the start forward drags it along.
    if (multiDay && next && endDate < next) setEndDate(next);
  }

  function toggleMultiDay() {
    if (!multiDay && (!endDate || endDate < date)) setEndDate(date);
    setMultiDay((on) => !on);
  }

  /** The request to send, or the sentence that stops it. */
  function validate(): BlockOffInput | string {
    if (!staffId) return "Pick a provider to block.";
    if (!isDayKey(date)) return "Pick a date.";
    if (date < todayKey) return "That date has already passed.";
    const note = reason.trim() || undefined;
    if (multiDay) {
      if (!isDayKey(endDate)) return "Pick an end date.";
      if (endDate < date) return "The end date must be on or after the start date.";
      if (dayCount(date, endDate) > MAX_BLOCK_DAYS) {
        return `Block up to ${MAX_BLOCK_DAYS} days at a time.`;
      }
      if (allDay) {
        return { kind: "days", staffId, fromDate: date, toDate: endDate, reason: note };
      }
      // The same hours on every day, as shop-local minutes; the API resolves
      // each day's instants itself. NaN from a cleared input fails the check.
      const fromMin = minutesOf(fromTime);
      const toMin = minutesOf(toTime);
      if (!(toMin > fromMin)) return "End time must be after the start time.";
      return {
        kind: "days",
        staffId,
        fromDate: date,
        toDate: endDate,
        window: { fromMin, toMin },
        reason: note,
      };
    }
    if (allDay) {
      return { kind: "days", staffId, fromDate: date, toDate: date, reason: note };
    }
    // Build ISO instants from the day + time inputs. Both are naive wall clock
    // in the SHOP's tz (the schedule the barber sees), so convert via the shop
    // tz - a device-local `new Date(...)` would block the wrong hours whenever
    // the barber's device is in a different timezone than the shop.
    const [y, m, d] = date.split("-").map(Number);
    const startsAt = zonedWallTimeToUtc(y!, m! - 1, d!, minutesOf(fromTime), timezone);
    const endsAt = zonedWallTimeToUtc(y!, m! - 1, d!, minutesOf(toTime), timezone);
    // NaN from a cleared input makes an Invalid Date, which compares false.
    if (!(endsAt.getTime() > startsAt.getTime())) {
      return "End time must be after the start time.";
    }
    return {
      kind: "timed",
      staffId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reason: note,
    };
  }

  async function submit(opts?: { confirmation?: string }) {
    // Read defensively: the footer button hands its click event here, so only
    // a real string counts - never a truthiness test on whatever was passed.
    const confirmation =
      typeof opts?.confirmation === "string" && opts.confirmation.length > 0
        ? opts.confirmation
        : undefined;
    if (inFlight.current) return;
    setError(null);
    setConflict(null);
    const input = validate();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await addBlockAction({ ...input, confirmation });
      if (!res.ok) {
        if (res.error === "appointments_overlap") {
          // Show the bookings, ask - the block is written only on confirm, and
          // only with the confirmation that names THESE bookings. Whatever the
          // answer, the bookings themselves are never touched.
          setConflict({
            reason: res.reason ?? "Appointments are already booked during this time.",
            confirmation: res.confirmation ?? "",
            details: res.conflicts,
          });
          return;
        }
        setError("Couldn't add the block. Please try again.");
        return;
      }
      toast(days > 1 ? `${days} days blocked off` : "Time blocked off", "success");
      onCreated();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Block off time"
      titleAlign="center"
      className="sm:max-w-lg"
      footer={
        <FormFooter
          error={error}
          label={days > 1 ? `Block ${days} days` : "Add block"}
          pendingLabel="Blocking…"
          pending={busy}
          onSubmit={() => submit()}
          // Deliberately NOT brass: blocking time is upkeep, not the money
          // path, and the two forms open from the same calendar.
          tone="quiet"
        />
      }
    >
      <div data-qa="block-off-form" className="flex min-w-0 flex-col gap-5">
        {conflict && (
          <ExternalBlockBanner
            conflict={conflict}
            pending={busy}
            confirmLabel="Block anyway"
            pendingLabel="Blocking…"
            consequence="Those appointments stay exactly as they are. The block only stops new bookings around them."
            dismissLabel="Change the dates"
            onConfirm={() => submit({ confirmation: conflict.confirmation })}
            onDismiss={() => setConflict(null)}
          />
        )}

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
          title="Date"
          action={
            <Pill on={multiDay} onClick={toggleMultiDay} qa="block-multi-day">
              Block multiple days
            </Pill>
          }
        >
          {multiDay ? (
            <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
              <Field label="Start date">
                <input
                  type="date"
                  className={INPUT}
                  value={date}
                  min={todayKey}
                  onChange={(e) => onDateChange(e.target.value)}
                />
              </Field>
              <Field label="End date">
                <input
                  type="date"
                  className={INPUT}
                  value={endDate}
                  min={date || todayKey}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="Date">
              <input
                type="date"
                className={INPUT}
                value={date}
                min={todayKey}
                onChange={(e) => onDateChange(e.target.value)}
              />
            </Field>
          )}
          {multiDay && (
            <p className="text-[11px] text-muted">
              Every day from the start date through the end date, inclusive.
            </p>
          )}
        </Group>

        {/* The same card for one day and for a range: a range takes these
            hours on EVERY day it covers, or all day on each. */}
        <Group
          title="Time"
          action={
            <Pill on={allDay} onClick={() => setAllDay((v) => !v)} qa="block-all-day">
              All day
            </Pill>
          }
        >
          {allDay ? (
            <p className="text-[11px] text-muted">
              {multiDay
                ? "Midnight to midnight on every day in the range."
                : "Midnight to midnight, nothing bookable that day."}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
                <Field label="From">
                  <input
                    type="time"
                    className={INPUT}
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </Field>
                <Field label="To">
                  <input
                    type="time"
                    className={INPUT}
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </Field>
              </div>
              {multiDay && (
                <p className="text-[11px] text-muted">
                  These hours are blocked on every day in the range.
                </p>
              )}
            </>
          )}
        </Group>

        <Group title="Note">
          <Field label="Only you see this">
            <input
              className={INPUT}
              placeholder="Lunch, day off, etc. (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          </Field>
        </Group>

        {/* What "Add block" will do, in words, before it does it. Reads the
            same state the submit reads, so it cannot describe a different
            block than the one about to be written. */}
        <div
          data-qa="block-summary"
          aria-live="polite"
          className="min-w-0 rounded-xl border border-subtle bg-charcoal-800/40 px-3.5 py-2.5"
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Blocks</p>
          <p className="mt-0.5 min-w-0 text-sm font-medium text-offwhite [overflow-wrap:anywhere]">
            {summary || "Pick when to block."}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** The header-row switch ("All day", "Block multiple days"): 44px pill, aria-pressed. */
function Pill({
  on,
  onClick,
  qa,
  children,
}: {
  on: boolean;
  onClick: () => void;
  qa: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-qa={qa}
      className={cn(
        // 44px hit area, pill look, header stays tight.
        "-my-2 flex h-11 flex-none items-center whitespace-nowrap rounded-full border px-3.5 text-xs font-medium transition-colors duration-150 ease-out",
        on ? "border-gold/50 bg-gold/10 text-gold" : "border-subtle text-muted hover:text-offwhite",
      )}
    >
      {children}
    </button>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
