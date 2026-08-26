"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import type { StaffRow } from "./page";
import { addBlockAction } from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "Block off time" (native), in the SAME chrome as the appointment sheet:
 * ui/Dialog shell, formkit cards. Blocks a time range on a provider's calendar
 * so no one can book it. Reuses the existing staff-exceptions endpoint.
 * `dayKey` (YYYY-MM-DD, shop tz) is the day tapped in the calendar.
 */
export function BlockOffForm({
  staff,
  dayKey,
  timezone,
  defaultFromHour,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  dayKey: string; // YYYY-MM-DD
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
  const [fromTime, setFromTime] = useState(pad(defaultFromHour) + ":00");
  const [toTime, setToTime] = useState(pad(Math.min(23, defaultFromHour + 1)) + ":00");
  // Whole-day switch: testers blocking a vacation were hand-typing 00:00-23:00
  // per day, which leaves 23:00-midnight open — a real slot for late-hours
  // shops. All day = local midnight to next-midnight, DST-exact.
  const [allDay, setAllDay] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    if (!staffId) return setError("Pick a provider to block.");
    // Build ISO instants from the day + time inputs. Both are naive wall clock
    // in the SHOP's tz (the schedule the barber sees), so convert via the shop
    // tz - a device-local `new Date(...)` would block the wrong hours whenever
    // the barber's device is in a different timezone than the shop.
    const [y, m, d] = dayKey.split("-").map(Number);
    const startsAt = allDay
      ? zonedWallTimeToUtc(y!, m! - 1, d!, 0, timezone)
      : zonedWallTimeToUtc(y!, m! - 1, d!, minutesOf(fromTime), timezone);
    const endsAt = allDay
      ? // Minute 1440 of the same date = 00:00 of the NEXT local day; the
        // day+1 form keeps DST right (a 23h/25h day blocks exactly that day).
        zonedWallTimeToUtc(y!, m! - 1, d! + 1, 0, timezone)
      : zonedWallTimeToUtc(y!, m! - 1, d!, minutesOf(toTime), timezone);
    if (!(endsAt.getTime() > startsAt.getTime())) {
      return setError("End time must be after the start time.");
    }
    start(async () => {
      const res = await addBlockAction({
        staffId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: reason.trim() || undefined,
      });
      if (!res.ok) {
        setError("Couldn't add the block. Please try again.");
        return;
      }
      toast("Time blocked off", "success");
      onCreated();
    });
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
          label="Add block"
          pendingLabel="Blocking…"
          pending={pending}
          onSubmit={submit}
          // Deliberately NOT brass: blocking time is upkeep, not the money
          // path, and the two forms open from the same calendar.
          tone="quiet"
        />
      }
    >
      <div data-qa="block-off-form" className="flex min-w-0 flex-col gap-5">
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
          title="Time"
          action={
            <button
              type="button"
              onClick={() => setAllDay((v) => !v)}
              aria-pressed={allDay}
              className={cn(
                // 44px hit area, pill look, header stays tight.
                "-my-2 flex h-11 items-center rounded-full border px-3.5 text-xs font-medium transition-colors duration-150 ease-out",
                allDay
                  ? "border-gold/50 bg-gold/10 text-gold"
                  : "border-subtle text-muted hover:text-offwhite",
              )}
            >
              All day
            </button>
          }
        >
          {!allDay && (
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
          <p className="text-[11px] text-muted">
            {allDay ? `All of ${dayKey} — nothing bookable` : dayKey}
          </p>
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
      </div>
    </Dialog>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:mm" -> minutes from midnight. NaN for a cleared input, which the
 *  end-after-start guard in submit() rejects (Invalid Date compares false). */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
