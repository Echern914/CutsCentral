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
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
}

const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => {
  const value = hhmm(i * 15);
  return { value, label: label(value) };
});

export function TimeSelect({
  value,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  // If the stored value isn't on the grid, prepend it so it still displays.
  const options = useMemo(() => {
    if (QUARTER_HOURS.some((o) => o.value === value)) return QUARTER_HOURS;
    return [{ value, label: label(value) }, ...QUARTER_HOURS];
  }, [value]);

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
