"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { TimeSelect } from "@/components/ui/TimeSelect";
import { Field, FormFooter, Group, INPUT } from "../booking/formkit";
import {
  addOwnTimeOffAction,
  getOwnHoursAction,
  removeOwnTimeOffAction,
  type OwnHours,
} from "./barberCalendarActions";
import { dayKeyIn, hhmmToMin, longDay, newSubmissionId, timeIn } from "./ownCalendarTime";

type TimeOff = OwnHours["exceptions"][number];

const TIME_SELECT =
  "h-11 w-full min-w-0 rounded-xl border border-subtle-strong bg-charcoal-800 px-3 text-base text-offwhite";

/** "Tue, Nov 24 · all day" or "Tue, Nov 24 · 1:00 PM to 2:00 PM", or a range of days. */
function describe(e: TimeOff, timezone: string): string {
  const firstDay = dayKeyIn(timezone, e.startsAt);
  const lastDay = dayKeyIn(timezone, new Date(new Date(e.endsAt).getTime() - 1).toISOString());
  const fromMidnight = timeIn(timezone, e.startsAt) === "12:00 AM";
  const toMidnight = timeIn(timezone, e.endsAt) === "12:00 AM";
  if (firstDay === lastDay) {
    return fromMidnight && toMidnight
      ? `${longDay(firstDay)} · all day`
      : `${longDay(firstDay)} · ${timeIn(timezone, e.startsAt)} to ${timeIn(timezone, e.endsAt)}`;
  }
  return fromMidnight && toMidnight
    ? `${longDay(firstDay)} to ${longDay(lastDay)}`
    : `${longDay(firstDay)} ${timeIn(timezone, e.startsAt)} to ${longDay(lastDay)} ${timeIn(timezone, e.endsAt)}`;
}

function addProblem(code: string | undefined): string {
  switch (code) {
    case "network_error":
      return "Couldn't reach the server. Tap again: it will not be added twice.";
    case "invalid_input":
      return "Check the dates and times: the end has to come after the start, and not in the past.";
    default:
      return "Couldn't save that. Nothing changed. Try again.";
  }
}

/**
 * Their own time off: what is coming up, and a form to block more. Bookings in
 * the way are named and must be confirmed; a block never cancels or moves a
 * booking. Time the shop blocked for several people is listed and left alone.
 */
export function BarberTimeOffSheet({
  timezone,
  startDay,
  today,
  onClose,
  onChanged,
}: {
  timezone: string;
  startDay: string;
  today: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<TimeOff[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeProblem, setRemoveProblem] = useState<{ id: string; copy: string } | null>(null);

  const [fromDate, setFromDate] = useState(startDay);
  const [toDate, setToDate] = useState(startDay);
  const [allDay, setAllDay] = useState(true);
  const [fromTime, setFromTime] = useState("12:00");
  const [toTime, setToTime] = useState("13:00");
  const [reason, setReason] = useState("");

  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Bookings in the way of the block being saved, and the answer that confirms them.
  const [inTheWay, setInTheWay] = useState<{ lines: string[]; confirmation: string } | null>(null);
  const request = useRef(newSubmissionId());

  const load = useCallback(async () => {
    setListFailed(false);
    const res = await getOwnHoursAction();
    if (!res.ok || !res.data) {
      setListFailed(true);
      return;
    }
    setList(res.data.exceptions.filter((e) => e.isBlock));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Changing the form answers the last refusal and makes this a new save.
  function edited() {
    setProblem(null);
    setSaid(null);
    setInTheWay(null);
    request.current = newSubmissionId();
  }

  async function save() {
    if (pending) return;
    if (toDate < fromDate) {
      setProblem("The last day has to be on or after the first day.");
      return;
    }
    if (!allDay && hhmmToMin(toTime) <= hhmmToMin(fromTime)) {
      setProblem("The end time has to be after the start time.");
      return;
    }
    setPending(true);
    setProblem(null);
    setSaid(null);
    const res = await addOwnTimeOffAction({
      fromDate,
      toDate,
      ...(allDay ? {} : { fromMin: hhmmToMin(fromTime), toMin: hhmmToMin(toTime) }),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      requestId: request.current,
      ...(inTheWay ? { confirmation: inTheWay.confirmation } : {}),
    });
    setPending(false);
    if (res.ok) {
      setSaid("Time off added. Nobody can book you then.");
      setInTheWay(null);
      setReason("");
      request.current = newSubmissionId();
      void load();
      onChanged();
      return;
    }
    if (res.error === "appointments_overlap" && res.confirmation) {
      setInTheWay({ lines: res.conflicts ?? [], confirmation: res.confirmation });
      return;
    }
    setInTheWay(null);
    if (res.error !== "network_error") request.current = newSubmissionId();
    setProblem(addProblem(res.error));
  }

  async function remove(id: string) {
    if (removing) return;
    setRemoving(id);
    setRemoveProblem(null);
    const res = await removeOwnTimeOffAction(id);
    setRemoving(null);
    if (res.ok || res.error === "not_found") {
      setList((cur) => (cur ? cur.filter((e) => e.id !== id) : cur));
      onChanged();
      return;
    }
    setRemoveProblem({
      id,
      copy:
        res.error === "shop_block"
          ? "The shop set this one. Ask the shop owner to change it."
          : "Couldn't remove it. Try again.",
    });
  }

  const footer = (
    <div className="flex w-full flex-col gap-2">
      {said && (
        <p role="status" className="text-sm text-offwhite">
          {said}
        </p>
      )}
      <FormFooter
        error={problem}
        label={inTheWay ? "Block the time anyway" : "Block this time"}
        pendingLabel="Saving…"
        pending={pending}
        onSubmit={() => void save()}
        tone="quiet"
      />
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Time off"
      subtitle="Block time on your own calendar so nobody can book you then."
      footer={footer}
      className="sm:max-w-md"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Group title="Block time">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day">
              <input
                type="date"
                className={INPUT}
                value={fromDate}
                min={today}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setFromDate(e.target.value);
                  if (toDate < e.target.value) setToDate(e.target.value);
                  edited();
                }}
              />
            </Field>
            <Field label="Last day">
              <input
                type="date"
                className={INPUT}
                value={toDate}
                min={fromDate}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setToDate(e.target.value);
                  edited();
                }}
              />
            </Field>
          </div>
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-offwhite">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={allDay}
              onChange={(e) => {
                setAllDay(e.target.checked);
                edited();
              }}
            />
            All day
          </label>
          {!allDay && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <TimeSelect
                  value={fromTime}
                  onChange={(v) => {
                    setFromTime(v);
                    edited();
                  }}
                  className={TIME_SELECT}
                  aria-label="Time off starts"
                />
              </Field>
              <Field label="To" hint={fromDate !== toDate ? "The same hours on each day." : undefined}>
                <TimeSelect
                  value={toTime}
                  onChange={(v) => {
                    setToTime(v);
                    edited();
                  }}
                  className={TIME_SELECT}
                  allowMidnightEnd
                  aria-label="Time off ends"
                />
              </Field>
            </div>
          )}
          <Field label="Note (optional)">
            <input
              className={INPUT}
              value={reason}
              maxLength={200}
              placeholder="Dentist, holiday…"
              onChange={(e) => {
                setReason(e.target.value);
                setProblem(null);
                setSaid(null);
              }}
            />
          </Field>
          {inTheWay && (
            <div role="alert" className="min-w-0 rounded-xl border border-warning-soft/40 bg-warning-soft/10 px-3 py-2.5">
              <p className="text-sm font-medium text-offwhite">
                {inTheWay.lines.length === 1 ? "A booking is" : "Bookings are"} already in this time:
              </p>
              <ul className="mt-1.5 list-disc pl-5 text-sm text-offwhite">
                {inTheWay.lines.map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Blocking the time does not cancel or move {inTheWay.lines.length === 1 ? "it" : "them"}.
                Move or cancel {inTheWay.lines.length === 1 ? "it" : "them"} from your day if you
                won&rsquo;t be there.
              </p>
            </div>
          )}
        </Group>

        <Group title="Coming up">
          {listFailed ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-danger-soft">Couldn&rsquo;t load your time off.</p>
              <button
                type="button"
                className="flex min-h-[44px] items-center rounded-xl border border-subtle px-4 text-sm text-offwhite"
                onClick={() => void load()}
              >
                Try again
              </button>
            </div>
          ) : list === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted">No time off coming up.</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-2">
              {list.map((e) => (
                <li key={e.id} className="min-w-0 rounded-xl border border-subtle px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-offwhite">{describe(e, timezone)}</p>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {e.shared ? "Set by the shop" : e.reason || "Time off"}
                        {e.shared && e.reason ? ` · ${e.reason}` : ""}
                      </p>
                    </div>
                    {!e.shared && (
                      <button
                        type="button"
                        className="flex min-h-[44px] shrink-0 items-center px-2 text-sm text-danger-soft hover:underline disabled:opacity-50"
                        disabled={removing !== null}
                        aria-label={`Remove time off, ${describe(e, timezone)}`}
                        onClick={() => void remove(e.id)}
                      >
                        {removing === e.id ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </div>
                  {removeProblem?.id === e.id && (
                    <p role="alert" className="mt-1 text-xs text-danger-soft">
                      {removeProblem.copy}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Group>
      </div>
    </Dialog>
  );
}
