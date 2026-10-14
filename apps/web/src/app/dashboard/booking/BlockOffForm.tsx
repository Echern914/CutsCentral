"use client";

import { useRef, useState } from "react";
import { describeBlockScope } from "@chairback/config/blockScope";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import type { ServiceRow, StaffRow } from "./page";
import { blockableServices, scopedServiceIds } from "./blockServices";
import { addBlockAction, type BlockOffInput } from "./actions";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";
import {
  blockSummary,
  dayCount,
  formatShortDay,
  isDayKey,
  MAX_BLOCK_DAYS,
  MAX_REPEAT_WEEKS,
  minutesOf,
  planDays,
  weeksThrough,
  type BlockPlan,
} from "./blockOffDates";

type Toast = (msg: string, kind?: "success" | "error") => void;

/** One day, a run of days, or the same day every week. */
type Span = "day" | "days" | "weekly";
/** Over a run of days: the same hours on each, or one unbroken stretch. */
type DaysShape = "each" | "through";

/** How many review dates are listed before "+N more". */
const REVIEW_DAYS = 8;

/**
 * "Block off time" (native), in the SAME chrome as the appointment sheet:
 * ui/Dialog shell, formkit cards. Blocks time on one or more providers'
 * calendars so no one can book it.
 *
 * What a barber can ask for, and what is sent (all SHOP-LOCAL day keys and
 * minutes - the API resolves every edge in the shop's zone, per day):
 *   - one day, all day or From-To;
 *   - several days, either the SAME HOURS ON EACH DAY ("every day Mon-Fri,
 *     12-1": the afternoons stay open) or ONE STRETCH ("Mon 9:00 straight
 *     through Fri 17:00": nothing in between is bookable);
 *   - the same day every week, a bounded number of weeks or until a date.
 *
 * What it stops: All services (the provider is not there), or Selected
 * services - "no Shape-ups or Kids' cuts 3-6 PM" - with every other service
 * still bookable over the same hours. The API enforces it on every booking
 * path; this form only picks it.
 *
 * Before saving, the Review card says what will be blocked, for whom, and on
 * which days. A save over existing bookings comes back as a refusal listing
 * them (ExternalBlockBanner) and is written only if the barber confirms -
 * the bookings themselves are never touched either way.
 *
 * Each Save carries a request id, re-sent only while the form is unchanged, so
 * a save whose answer was lost and is tapped again is not written twice.
 */
export function BlockOffForm({
  staff,
  services = [],
  dayKey,
  todayKey,
  defaultFromHour,
  acuityConnected = false,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  /** The shop's menu, for "Selected services". */
  services?: ServiceRow[];
  dayKey: string; // YYYY-MM-DD, shop tz - the day tapped in the calendar
  todayKey: string; // YYYY-MM-DD, shop tz - the earliest day worth blocking
  /** IANA shop tz. Kept for callers; the API resolves every edge in it now. */
  timezone?: string;
  defaultFromHour: number; // 0-23, the tapped hour
  /** The shop syncs with Acuity: say plainly that this block is not copied there. */
  acuityConnected?: boolean;
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const activeStaff = staff.filter((s) => s.active);
  const [staffIds, setStaffIds] = useState<string[]>(
    activeStaff.length === 1 ? [activeStaff[0]!.id] : [],
  );
  // The calendar's day, unless it has already passed - a block on a day that
  // is gone does nothing, so the form starts on the first day it could matter.
  const initialDate = dayKey < todayKey ? todayKey : dayKey;
  const [date, setDate] = useState(initialDate);
  const [span, setSpan] = useState<Span>("day");
  const [shape, setShape] = useState<DaysShape>("each");
  const [endDate, setEndDate] = useState(initialDate);
  const [repeatBy, setRepeatBy] = useState<"count" | "until">("count");
  const [weeks, setWeeks] = useState("4");
  const [untilDate, setUntilDate] = useState(initialDate);
  const [fromTime, setFromTime] = useState(pad(defaultFromHour) + ":00");
  // The 11 PM row runs to midnight ("00:00"), not 11 PM - 11 PM to 11 PM
  // opened the form already refused.
  const [toTime, setToTime] = useState(defaultFromHour >= 23 ? "00:00" : pad(defaultFromHour + 1) + ":00");
  // Whole-day switch: All day = local midnight to next-midnight, DST-exact
  // (the API does that arithmetic from the day key).
  const [allDay, setAllDay] = useState(false);
  const [reason, setReason] = useState("");
  // All services = the whole chair (every block before scopes existed).
  const [serviceScope, setServiceScope] = useState<"all" | "some">("all");
  const [pickedServices, setPickedServices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BlockConflict | null>(null);
  // Own flag, not useTransition's: isPending does not span the await inside
  // an async transition. The ref refuses a second submit inside one handler.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // 🔴 ONE SAVE, ONE BLOCK. The id is bound to exactly what is being saved:
  // the same input re-sends the same id (a lost answer tapped again is
  // answered from the rows the first try wrote), any change mints a new one.
  const request = useRef<{ key: string; id: string } | null>(null);

  const through = span === "days" && shape === "through" && !allDay;
  const hoursWindow = allDay ? undefined : { fromTime, toTime };
  const weekCount =
    repeatBy === "count" ? Number.parseInt(weeks, 10) || 0 : weeksThrough(date, untilDate);
  const plan: BlockPlan =
    span === "weekly"
      ? { kind: "weekly", date, weeks: weekCount, window: hoursWindow }
      : span === "days"
        ? through
          ? { kind: "through", fromDate: date, fromTime, toDate: endDate, toTime }
          : { kind: "days", fromDate: date, toDate: endDate, window: hoursWindow }
        : allDay
          ? { kind: "days", fromDate: date, toDate: date }
          : { kind: "timed", date, fromTime, toTime };
  const summary = blockSummary(plan, todayKey);
  const days = planDays(plan);
  const chosen = activeStaff.filter((s) => staffIds.includes(s.id));
  const offeredServices = blockableServices(services, staffIds);
  const scopedIds =
    serviceScope === "some" ? scopedServiceIds(pickedServices, offeredServices) : [];
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const scopeLine = describeBlockScope(scopedIds, (id) => serviceName.get(id));

  function toggleService(id: string) {
    setPickedServices((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function onDateChange(next: string) {
    setDate(next);
    // The end never trails the start; nudging the start forward drags it along.
    if (next && endDate < next) setEndDate(next);
    if (next && untilDate < next) setUntilDate(next);
  }

  function chooseSpan(next: Span) {
    if (next === "days" && (!endDate || endDate < date)) setEndDate(date);
    setSpan(next);
  }

  function toggleStaff(id: string) {
    setStaffIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  /** "HH:mm" end -> minutes, where 12:00 AM is the END of the day (1440). */
  const endMinutes = (hhmm: string) => (hhmm === "00:00" ? 24 * 60 : minutesOf(hhmm));

  /** The request to send (without its id), or the sentence that stops it. */
  function validate(): Omit<BlockOffInput, "requestId"> | string {
    if (staffIds.length === 0) return "Pick who to block.";
    if (serviceScope === "some" && scopedIds.length === 0) {
      return "Pick at least one service, or choose All services.";
    }
    if (!isDayKey(date)) return "Pick a date.";
    if (date < todayKey) return "That date has already passed.";
    const note = reason.trim() || undefined;
    // Sent only for Selected services: absent is All services.
    const scope = scopedIds.length > 0 ? { serviceIds: scopedIds } : {};
    const fromMin = minutesOf(fromTime);
    const toMin = endMinutes(toTime);
    // NaN from a cleared input fails every comparison below.
    const hours = allDay ? {} : { fromMin, toMin };
    if (!allDay && !through && !(toMin > fromMin)) return "End time must be after the start time.";

    if (span === "days") {
      if (!isDayKey(endDate)) return "Pick an end date.";
      if (endDate < date) return "The end date must be on or after the start date.";
      if (dayCount(date, endDate) > MAX_BLOCK_DAYS) {
        return `Block up to ${MAX_BLOCK_DAYS} days at a time.`;
      }
      if (through) {
        if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) return "Pick a start and an end time.";
        if (endDate === date && !(toMin > fromMin)) return "The end must be after the start.";
        return {
          staffIds,
          when: { kind: "continuous", fromDate: date, fromMin, toDate: endDate, toMin },
          ...scope,
          reason: note,
        };
      }
      return {
        staffIds,
        when: { kind: "daily", fromDate: date, toDate: endDate, ...hours },
        ...scope,
        reason: note,
      };
    }
    if (span === "weekly") {
      if (repeatBy === "until") {
        if (!isDayKey(untilDate)) return "Pick the last date.";
        if (untilDate < date) return "The last date must be on or after the first.";
      }
      if (!(weekCount >= 1)) return "Pick how many weeks.";
      if (weekCount > MAX_REPEAT_WEEKS) return `Repeat up to ${MAX_REPEAT_WEEKS} weeks.`;
      return {
        staffIds,
        when: {
          kind: "day",
          date,
          ...hours,
          repeat: repeatBy === "until" ? { until: untilDate } : { weeks: weekCount },
        },
        ...scope,
        reason: note,
      };
    }
    return { staffIds, when: { kind: "day", date, ...hours }, ...scope, reason: note };
  }

  function requestIdFor(input: Omit<BlockOffInput, "requestId">): string {
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: newRequestId() };
    return request.current.id;
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
      const res = await addBlockAction({ ...input, requestId: requestIdFor(input), confirmation });
      if (!res.ok) {
        if (res.error === "appointments_overlap") {
          // The review, with the bookings in the way: written only on confirm,
          // and only with the confirmation that names THESE bookings.
          setConflict({
            reason: res.reason ?? "Appointments are already booked during this time.",
            confirmation: res.confirmation ?? "",
            details: res.conflicts,
          });
          return;
        }
        setError(res.message ?? "Couldn't add the block. Please try again.");
        return;
      }
      const what =
        span === "weekly" && weekCount > 1
          ? `${weekCount} weeks blocked off`
          : days.length > 1
            ? `${days.length} days blocked off`
            : "Time blocked off";
      toast(chosen.length > 1 ? `${what} for ${chosen.length} providers` : what, "success");
      onCreated();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const saveLabel =
    span === "weekly" && weekCount > 1
      ? `Block ${weekCount} weeks`
      : days.length > 1
        ? `Block ${days.length} days`
        : "Add block";

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
          label={saveLabel}
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
          <Group
            title="Who"
            action={
              <Pill
                on={staffIds.length === activeStaff.length}
                onClick={() =>
                  setStaffIds(
                    staffIds.length === activeStaff.length ? [] : activeStaff.map((s) => s.id),
                  )
                }
                qa="block-everyone"
              >
                Everyone
              </Pill>
            }
          >
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Providers">
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={staffIds.includes(s.id)}
                  onClick={() => toggleStaff(s.id)}
                  className={chip(staffIds.includes(s.id), "min-w-0 px-4")}
                >
                  <span className="truncate">{s.name}</span>
                </button>
              ))}
            </div>
          </Group>
        )}

        <Group title="Services">
          <div data-qa="block-scope" className="flex gap-1.5" role="group" aria-label="Which services">
            {(
              [
                ["all", "All services"],
                ["some", "Selected services"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={serviceScope === value}
                onClick={() => setServiceScope(value)}
                className={chip(serviceScope === value, "min-w-0 flex-1 px-2 text-center leading-tight")}
              >
                {label}
              </button>
            ))}
          </div>
          {serviceScope === "all" ? (
            <p className="text-[11px] text-muted">Nothing can be booked in this time.</p>
          ) : offeredServices.length === 0 ? (
            <p data-qa="block-services-none" className="text-[11px] text-muted">
              {staffIds.length > 1
                ? "These providers have no service in common. Block them one at a time, or choose All services."
                : "No services to pick yet. Add services first, or choose All services."}
            </p>
          ) : (
            <>
              <div
                data-qa="block-services"
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label="Services to block"
              >
                {offeredServices.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={scopedIds.includes(s.id)}
                    onClick={() => toggleService(s.id)}
                    className={chip(scopedIds.includes(s.id), "min-w-0 px-4")}
                  >
                    <span className="truncate">{s.name}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted">
                Only these can&apos;t be booked in this time. Every other service stays bookable, add-ons included.
              </p>
            </>
          )}
        </Group>

        <Group title="When">
          {/* Three answers to "how long", side by side even at 320px: each
              cell shares the row (min-w-0 flex-1) instead of a squashed column. */}
          <div data-qa="block-span" className="flex gap-1.5" role="group" aria-label="How long">
            {(
              [
                ["day", "One day"],
                ["days", "Several days"],
                ["weekly", "Every week"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={span === value}
                onClick={() => chooseSpan(value)}
                className={chip(span === value, "min-w-0 flex-1 px-2 text-center leading-tight")}
              >
                {label}
              </button>
            ))}
          </div>

          {span === "days" ? (
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
            <Field label={span === "weekly" ? "First date" : "Date"}>
              <input
                type="date"
                className={INPUT}
                value={date}
                min={todayKey}
                onChange={(e) => onDateChange(e.target.value)}
              />
            </Field>
          )}

          {span === "weekly" && (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex gap-1.5" role="group" aria-label="Repeat until">
                <button
                  type="button"
                  aria-pressed={repeatBy === "count"}
                  onClick={() => setRepeatBy("count")}
                  className={chip(repeatBy === "count", "min-w-0 flex-1 px-2")}
                >
                  A number of weeks
                </button>
                <button
                  type="button"
                  aria-pressed={repeatBy === "until"}
                  onClick={() => setRepeatBy("until")}
                  className={chip(repeatBy === "until", "min-w-0 flex-1 px-2")}
                >
                  Until a date
                </button>
              </div>
              {repeatBy === "count" ? (
                <Field label="Weeks" hint={`Up to ${MAX_REPEAT_WEEKS}, counting this one.`}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_REPEAT_WEEKS}
                    className={INPUT}
                    value={weeks}
                    onChange={(e) => setWeeks(e.target.value)}
                  />
                </Field>
              ) : (
                <Field label="Last date">
                  <input
                    type="date"
                    className={INPUT}
                    value={untilDate}
                    min={date || todayKey}
                    onChange={(e) => setUntilDate(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}
        </Group>

        <Group
          title="Time"
          action={
            <Pill on={allDay} onClick={() => setAllDay((v) => !v)} qa="block-all-day">
              All day
            </Pill>
          }
        >
          {span === "days" && !allDay && (
            <div data-qa="block-days-shape" className="flex gap-1.5" role="group" aria-label="Across the days">
              <button
                type="button"
                aria-pressed={shape === "each"}
                onClick={() => setShape("each")}
                className={chip(shape === "each", "min-w-0 flex-1 px-2 text-center leading-tight")}
              >
                Same hours each day
              </button>
              <button
                type="button"
                aria-pressed={shape === "through"}
                onClick={() => setShape("through")}
                className={chip(shape === "through", "min-w-0 flex-1 px-2 text-center leading-tight")}
              >
                One stretch
              </button>
            </div>
          )}
          {allDay ? (
            <p className="text-[11px] text-muted">
              {span === "day"
                ? "Midnight to midnight, nothing bookable that day."
                : "Midnight to midnight on every day it covers."}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
                <Field label={through ? "Starts (first day)" : "From"}>
                  <input
                    type="time"
                    className={INPUT}
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </Field>
                <Field label={through ? "Ends (last day)" : "To"}>
                  <input
                    type="time"
                    className={INPUT}
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </Field>
              </div>
              {span === "days" && (
                <p className="text-[11px] text-muted">
                  {through
                    ? "Blocked from the start time on the first day straight through the end time on the last day - nothing in between is bookable."
                    : "These hours are blocked on every day in the range. The rest of each day stays open."}
                </p>
              )}
              {span === "weekly" && (
                <p className="text-[11px] text-muted">These hours on the same day every week.</p>
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

        {/* THE REVIEW. What Save will do, in words, before it does it: what,
            for whom, on which days. Reads the same state the submit reads, so
            it cannot describe a different block than the one about to be
            written. Bookings in the way are added by the server's refusal. */}
        <div
          data-qa="block-summary"
          aria-live="polite"
          className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-subtle bg-charcoal-800/40 px-3.5 py-2.5"
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Review</p>
          <p
            data-qa="block-summary-line"
            className="min-w-0 text-sm font-medium text-offwhite [overflow-wrap:anywhere]"
          >
            {summary || "Pick when to block."}
          </p>
          <p data-qa="block-review-services" className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
            {serviceScope === "all"
              ? "All services"
              : scopedIds.length === 0
                ? "No services picked yet."
                : `${scopeLine}. Everything else stays bookable.`}
          </p>
          {activeStaff.length > 1 && (
            <p data-qa="block-review-who" className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
              {chosen.length === 0 ? "No one picked yet." : `For ${chosen.map((s) => s.name).join(", ")}`}
            </p>
          )}
          {summary && days.length > 1 && (
            <ul data-qa="block-review-days" className="flex min-w-0 flex-wrap gap-1" aria-label="Dates">
              {days.slice(0, REVIEW_DAYS).map((d) => (
                <li
                  key={d}
                  className="rounded-md bg-charcoal-700/60 px-1.5 py-0.5 text-[11px] tabular-nums text-offwhite/85"
                >
                  {formatShortDay(d)}
                </li>
              ))}
              {days.length > REVIEW_DAYS && (
                <li className="px-1 py-0.5 text-[11px] text-muted">+{days.length - REVIEW_DAYS} more</li>
              )}
            </ul>
          )}
          <p className="text-[11px] text-muted">
            Appointments already booked in this time stay as they are. You&apos;ll see them before anything is saved.
          </p>
          {acuityConnected && (
            <p data-qa="block-acuity-note" className="text-[11px] text-muted">
              This block isn&apos;t copied to Acuity yet. Block the same time in Acuity too, or it can still be booked there.
            </p>
          )}
          {acuityConnected && serviceScope === "some" && (
            <p data-qa="block-acuity-services-note" className="text-[11px] text-muted">
              Acuity can only block a whole calendar, not single services, so Acuity bookings can still take these
              services in this time. ChairBack bookings can&apos;t.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The header-row switch ("All day", "Everyone"): 44px pill, aria-pressed. */
export function Pill({
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

/** One id per Save. crypto.randomUUID where it exists (every current browser). */
function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
