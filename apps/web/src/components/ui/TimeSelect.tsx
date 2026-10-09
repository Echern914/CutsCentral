"use client";

import { useMemo } from "react";

/**
 * A time picker as a single native <select> of 96 quarter-hour options
 * ("12:00 AM" … "11:45 PM"). One tap on an iPad, no hour/minute coordination,
 * and the value is the same "HH:MM" (24h) string the availability helpers
 * already produce/consume (minToHHMM/hhmmToMin) - so it's a drop-in for the
 * raw <input type="time"> fields in the Hours tab and the service editor.
 *
 * A stored value that isn't on the 15-min grid (a legacy typed time like
 * "09:07") is preserved as an extra leading option rather than silently reset.
 *
 * 🔴 MIDNIGHT AS AN END. "00:00" is the START of a day, so a barber working
 * until midnight had no way to say so: picking 12:00 AM as the end was refused
 * as "end before start", and the last slots of a late night were unbookable.
 * The API stores an end of 1440 ("24:00") for exactly this; an END picker
 * passes `allowMidnightEnd` to offer it last, labelled "12:00 AM (midnight)".
 */

// "HH:MM" (24h) for a minute-of-day. Module scope: built once.
function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
// "H:MM AM/PM" display for a "HH:MM" value.
function label(value: string): string {
  const [h, m] = value.split(":").map(Number);
  const hour = h ?? 0;
  // A stored end of 1440 used to read "12:00 PM" (24 % 12 = 0, and 24 is not
  // under 12): noon, on a shift that ran until midnight.
  if (hour === 24) return "12:00 AM (midnight)";
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
}

const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => {
  const value = hhmm(i * 15);
  return { value, label: label(value) };
});

/** The end of the day, for an end picker only (see the note above). */
export const MIDNIGHT_END = "24:00";
const WITH_MIDNIGHT_END = [...QUARTER_HOURS, { value: MIDNIGHT_END, label: label(MIDNIGHT_END) }];

export function TimeSelect({
  value,
  onChange,
  disabled,
  className,
  allowMidnightEnd,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  /** An END time: offer "12:00 AM (midnight)" ("24:00") after 11:45 PM. */
  allowMidnightEnd?: boolean;
  "aria-label"?: string;
}) {
  // If the stored value isn't on the grid, prepend it so it still displays.
  const options = useMemo(() => {
    const grid = allowMidnightEnd ? WITH_MIDNIGHT_END : QUARTER_HOURS;
    if (grid.some((o) => o.value === value)) return grid;
    return [{ value, label: label(value) }, ...grid];
  }, [value, allowMidnightEnd]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
