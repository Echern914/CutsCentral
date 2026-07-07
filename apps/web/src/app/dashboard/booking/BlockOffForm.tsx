"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { Sheet } from "./AppointmentForm";
import type { StaffRow } from "./page";
import { addBlockAction } from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * ChairBack-styled "Block Off Time" sheet (native). Blocks a time range on a
 * provider's calendar so no one can book it. Reuses the existing staff-exceptions
 * endpoint. `dayKey` (YYYY-MM-DD, shop tz) is the day tapped in the calendar.
 */
export function BlockOffForm({
  staff,
  dayKey,
  defaultFromHour,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  dayKey: string; // YYYY-MM-DD
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
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    if (!staffId) return setError("Pick a provider to block.");
    // Build ISO instants from the day + local time inputs. datetime is naive;
    // interpret in the viewer's zone (barber is typically in the shop's zone).
    const startsAt = new Date(`${dayKey}T${fromTime}`);
    const endsAt = new Date(`${dayKey}T${toTime}`);
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

  const label = "text-[11px] font-medium uppercase tracking-wide text-muted";
  const input =
    "rounded-lg border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite";

  return (
    <Sheet title="Block off time" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {activeStaff.length > 1 && (
          <div>
            <p className={label}>Provider</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStaffId(s.id)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    staffId === s.id
                      ? "border-gold/50 bg-gold/10 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className={label}>Time</p>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              type="time"
              className={input}
              value={fromTime}
              onChange={(e) => setFromTime(e.target.value)}
            />
            <span className="text-sm text-muted">to</span>
            <input
              type="time"
              className={input}
              value={toTime}
              onChange={(e) => setToTime(e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted">{dayKey}</p>
        </div>

        <div>
          <p className={label}>Note</p>
          <input
            className={cn(input, "mt-1.5 w-full")}
            placeholder="Lunch, day off, etc. (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
          />
        </div>

        {error && <p className="text-sm text-danger-soft">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="w-full rounded-xl bg-offwhite py-3 text-center text-sm font-semibold text-charcoal transition-colors hover:bg-white disabled:opacity-50"
        >
          {pending ? "Blocking…" : "Add block"}
        </button>
      </div>
    </Sheet>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
