"use client";

import { useEffect, useRef, useState } from "react";
import { zonedDateKey, zonedMinutesOfDay } from "@chairback/config/time";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import {
  editBlockAction,
  getBlockAction,
  removeBlockAction,
  type BlockDetail,
  type BlockEditInput,
} from "./actions";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";
import { Pill } from "./BlockOffForm";
import {
  addDaysToKey,
  formatClock,
  formatDay,
  formatDayRange,
  isDayKey,
  minutesOf,
} from "./blockOffDates";

type Toast = (msg: string, kind?: "success" | "error") => void;
type Scope = "one" | "group";

const PATTERN_LABEL: Record<NonNullable<BlockDetail["pattern"]>, string | null> = {
  single: null,
  daily: "Same hours each day",
  continuous: "One stretch across days",
  weekly: "Repeats weekly",
};

/** "HH:mm" of minutes from midnight; 1440 (end of day) reads as "00:00". */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The block's own day and hours, in the SHOP's zone, as the form edits them. */
function wallOf(block: BlockDetail, tz: string) {
  const start = new Date(block.startsAt);
  const end = new Date(block.endsAt);
  const day = zonedDateKey(start, tz);
  const fromMin = zonedMinutesOfDay(start, tz);
  const endDay = zonedDateKey(end, tz);
  const endMin = zonedMinutesOfDay(end, tz);
  // Ends at the next midnight: "through the end of the day".
  const toMin = endMin === 0 && endDay === addDaysToKey(day, 1) ? 24 * 60 : endMin;
  return { day, fromMin, toMin, allDay: fromMin === 0 && toMin === 24 * 60 };
}

/**
 * A blocked-off band, opened: what it is, the save it came from, and the
 * three things a barber does with it - change its note or hours, take it
 * back, or do either for the whole group it was saved in.
 *
 * 🔴 REMOVING ASKS FIRST. It used to be one tap on the band, and a barber who
 * brushed it gave away a day off with nothing to say so. Now the question
 * names exactly what goes: "Remove this block?" or "Remove all 6 blocks in
 * this group?" - the group being the blocks from the same save that are still
 * to come.
 *
 * A new time is checked against bookings exactly like a save (the same
 * refusal, the same "anyway"), and bookings are never moved.
 */
export function BlockEditSheet({
  blockId,
  onClose,
  onChanged,
  toast,
}: {
  blockId: string;
  onClose: () => void;
  onChanged: () => void;
  toast: Toast;
}) {
  const [loaded, setLoaded] = useState<{ block: BlockDetail; tz: string } | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    void getBlockAction(blockId)
      .then((res) => {
        if (!alive) return;
        if (res.ok) setLoaded({ block: res.block, tz: res.timezone });
        else setLoadError(true);
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [blockId]);

  if (!loaded) {
    return (
      <Dialog open onClose={onClose} title="Blocked time" titleAlign="center" className="sm:max-w-lg">
        <p className="py-6 text-center text-sm text-muted" role={loadError ? "alert" : "status"}>
          {loadError ? "Couldn't open this block. It may have been removed." : "Loading…"}
        </p>
      </Dialog>
    );
  }
  return (
    <LoadedBlockSheet
      block={loaded.block}
      tz={loaded.tz}
      onClose={onClose}
      onChanged={onChanged}
      toast={toast}
    />
  );
}

function LoadedBlockSheet({
  block,
  tz,
  onClose,
  onChanged,
  toast,
}: {
  block: BlockDetail;
  tz: string;
  onClose: () => void;
  onChanged: () => void;
  toast: Toast;
}) {
  const wall = wallOf(block, tz);
  const todayKey = zonedDateKey(new Date(), tz);
  const groupCount = block.group.count;
  const inGroup = groupCount > 1;

  const [scope, setScope] = useState<Scope>("one");
  const [date, setDate] = useState(wall.day);
  const [allDay, setAllDay] = useState(wall.allDay);
  const [fromTime, setFromTime] = useState(hhmm(wall.fromMin));
  const [toTime, setToTime] = useState(hhmm(wall.toMin));
  const [reason, setReason] = useState(block.reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BlockConflict | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const timesEditable = scope === "one" || block.group.timesEditable;
  const endMin = (v: string) => (v === "00:00" ? 24 * 60 : minutesOf(v));
  const timeChanged =
    allDay !== wall.allDay ||
    (!allDay && (minutesOf(fromTime) !== wall.fromMin || endMin(toTime) !== wall.toMin)) ||
    (scope === "one" && date !== wall.day);
  const noteChanged = reason.trim() !== (block.reason ?? "");

  function build(): BlockEditInput | string {
    const input: BlockEditInput = { scope };
    if (noteChanged) input.reason = reason.trim();
    if (timesEditable && timeChanged) {
      const hours = allDay ? {} : { fromMin: minutesOf(fromTime), toMin: endMin(toTime) };
      if (!allDay && !(hours.toMin! > hours.fromMin!)) return "End time must be after the start time.";
      if (scope === "one") {
        if (!isDayKey(date)) return "Pick a date.";
        if (date < todayKey) return "That date has already passed.";
        input.timing = { kind: "day", date, ...hours };
      } else {
        input.timing = { kind: "window", ...hours };
      }
    }
    if (input.reason === undefined && !input.timing) return "Nothing has changed yet.";
    return input;
  }

  async function save(opts?: { confirmation?: string }) {
    const confirmation =
      typeof opts?.confirmation === "string" && opts.confirmation.length > 0
        ? opts.confirmation
        : undefined;
    if (inFlight.current) return;
    setError(null);
    setConflict(null);
    const input = build();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await editBlockAction(block.id, { ...input, confirmation });
      if (!res.ok) {
        if (res.error === "appointments_overlap") {
          setConflict({
            reason: res.reason ?? "Appointments are already booked during this time.",
            confirmation: res.confirmation ?? "",
            details: res.conflicts,
          });
          return;
        }
        setError(
          res.message ??
            (res.error === "not_found"
              ? "This block is gone. It may have been removed."
              : res.error === "already_blocked"
                ? "Another block from the same save already starts then."
                : "Couldn't save the block. Please try again."),
        );
        return;
      }
      toast(scope === "group" ? `${groupCount} blocks updated` : "Block updated", "success");
      onChanged();
      onClose();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (inFlight.current) return;
    setError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await removeBlockAction(block.id, scope);
      if (!res.ok) {
        setError(
          res.error === "not_found"
            ? "This block is already gone."
            : "Couldn't remove the block. Please try again.",
        );
        setAsking(false);
        return;
      }
      const n = res.removed ?? 1;
      toast(n > 1 ? `${n} blocks removed` : "Time unblocked", "success");
      onChanged();
      onClose();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // What the block is, in the shop's words, before anything is changed.
  const when = wall.allDay
    ? `${formatDay(wall.day, todayKey)} · All day`
    : wall.toMin === 24 * 60
      ? `${formatDay(wall.day, todayKey)} · ${formatClock(hhmm(wall.fromMin))} to the end of the day`
      : `${formatDay(wall.day, todayKey)} · ${formatClock(hhmm(wall.fromMin))}–${formatClock(hhmm(wall.toMin))}`;
  const days = block.group.days;
  const groupSpan =
    days.length > 1 ? formatDayRange(days[0]!, days[days.length - 1]!, todayKey) : null;
  const patternLabel = block.pattern ? PATTERN_LABEL[block.pattern] : null;
  const removeQuestion =
    scope === "group" && inGroup
      ? `Remove all ${groupCount} blocks in this group?`
      : "Remove this block?";

  return (
    <Dialog
      open
      onClose={onClose}
      title="Blocked time"
      titleAlign="center"
      className="sm:max-w-lg"
      footer={
        asking ? undefined : (
          <FormFooter
            error={error}
            label={scope === "group" ? `Save all ${groupCount}` : "Save changes"}
            pendingLabel="Saving…"
            pending={busy}
            onSubmit={() => save()}
            tone="quiet"
          />
        )
      }
    >
      <div data-qa="block-edit-sheet" className="flex min-w-0 flex-col gap-5">
        <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-subtle bg-charcoal-800/40 px-3.5 py-2.5">
          <p className="min-w-0 text-sm font-medium text-offwhite [overflow-wrap:anywhere]">{when}</p>
          <p className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
            {block.staffName}
            {block.reason ? ` · ${block.reason}` : ""}
          </p>
          {inGroup && (
            <p data-qa="block-group-line" className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
              Saved together: {groupCount} blocks
              {block.group.staff.length > 1 ? ` · ${block.group.staff.map((s) => s.name).join(", ")}` : ""}
              {groupSpan ? ` · ${groupSpan}` : ""}
              {patternLabel ? ` · ${patternLabel}` : ""}
            </p>
          )}
        </div>

        {conflict && (
          <ExternalBlockBanner
            conflict={conflict}
            pending={busy}
            confirmLabel="Save anyway"
            pendingLabel="Saving…"
            consequence="Those appointments stay exactly as they are. The block only stops new bookings around them."
            dismissLabel="Change the time"
            onConfirm={() => save({ confirmation: conflict.confirmation })}
            onDismiss={() => setConflict(null)}
          />
        )}

        {inGroup && (
          <div data-qa="block-scope" className="flex gap-1.5" role="group" aria-label="Change">
            <button
              type="button"
              aria-pressed={scope === "one"}
              onClick={() => setScope("one")}
              className={chip(scope === "one", "min-w-0 flex-1 px-2 text-center leading-tight")}
            >
              This block
            </button>
            <button
              type="button"
              aria-pressed={scope === "group"}
              onClick={() => setScope("group")}
              className={chip(scope === "group", "min-w-0 flex-1 px-2 text-center leading-tight")}
            >
              All {groupCount} in this group
            </button>
          </div>
        )}

        <Group
          title="Time"
          action={
            timesEditable ? (
              <Pill on={allDay} onClick={() => setAllDay((v) => !v)} qa="block-edit-all-day">
                All day
              </Pill>
            ) : undefined
          }
        >
          {!timesEditable ? (
            <p className="text-[11px] text-muted">
              This block runs across days, so its hours change one day at a time. Pick &quot;This block&quot; to change one.
            </p>
          ) : (
            <>
              {scope === "one" && (
                <Field label="Date">
                  <input
                    type="date"
                    className={INPUT}
                    value={date}
                    min={todayKey}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
              )}
              {allDay ? (
                <p className="text-[11px] text-muted">
                  {scope === "group" ? "Midnight to midnight on each day in the group." : "Midnight to midnight."}
                </p>
              ) : (
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
              )}
              {scope === "group" && (
                <p className="text-[11px] text-muted">These hours on each day in the group, each on its own date.</p>
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

        {asking ? (
          <div
            role="alertdialog"
            aria-labelledby="block-remove-question"
            data-qa="block-remove-confirm"
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-danger-soft/40 bg-danger-soft/5 p-3"
          >
            <p id="block-remove-question" className="min-w-0 text-sm font-medium text-offwhite [overflow-wrap:anywhere]">
              {removeQuestion}
            </p>
            <p className="text-xs text-muted">
              That time becomes bookable again wherever nothing else - another block, a weekly break or a booking - still holds it.
            </p>
            {error && (
              <p role="alert" className="text-xs text-danger-soft">
                {error}
              </p>
            )}
            {/* Side by side at full height on a phone (#635): never a squashed column. */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAsking(false)}
                disabled={busy}
                className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
              >
                {busy ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-qa="block-remove"
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
            className="flex h-11 min-w-0 items-center justify-center rounded-xl border border-danger-soft/40 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
          >
            {scope === "group" && inGroup ? `Remove all ${groupCount}` : "Remove block"}
          </button>
        )}
      </div>
    </Dialog>
  );
}
