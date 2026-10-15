"use client";

import { cn } from "@/lib/cn";
import {
  dayLine,
  nowLabel,
  spansLabel,
  type ChairDay,
  type ScheduleSpan,
} from "@/lib/teamSchedule";

/**
 * One person's day: where they are now, their hours, and a bar of the day -
 * working, booked, off - on the page's shared scale.
 *
 * 🔴 ONE COMPONENT, TWO PAGES, like MemberStatGrid: the owner's Team schedule
 * and the member's own "how your day looks" preview both render it, so the
 * preview can't show the barber anything the owner doesn't see.
 */
export function ScheduleRow({
  day,
  timezone,
  range,
  label,
  qa,
}: {
  day: ChairDay;
  timezone: string;
  /** The scale shared by every bar on the page; null draws no bar. */
  range: { from: number; to: number } | null;
  /** The name to show - the business, or the person when a business has several. */
  label?: string;
  qa?: string;
}) {
  const now = day.now ? nowLabel(day.now, timezone) : null;
  return (
    <div className="min-w-0" data-qa={qa}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {label && <p className="min-w-0 truncate text-sm font-medium text-offwhite">{label}</p>}
        {now && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
              now.tone === "free"
                ? "bg-emerald-soft/15 text-emerald-soft"
                : now.tone === "busy"
                  ? "bg-gold/10 text-gold"
                  : "bg-charcoal-700 text-muted",
            )}
            data-qa="schedule-now"
          >
            {now.text}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{dayLine(day, timezone)}</p>
      {range && <DayBar day={day} range={range} />}
      {day.free.length > 0 && (
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          <span className="text-emerald-soft">Free</span> {spansLabel(day.free, timezone)}
        </p>
      )}
    </div>
  );
}

/**
 * The bar. Decoration only - every fact on it is also in the text above it,
 * which is what a screen reader gets.
 */
function DayBar({ day, range }: { day: ChairDay; range: { from: number; to: number } }) {
  const width = range.to - range.from;
  const place = (s: ScheduleSpan) => {
    const start = Math.max(Date.parse(s.start), range.from);
    const end = Math.min(Date.parse(s.end), range.to);
    return {
      left: `${((start - range.from) / width) * 100}%`,
      width: `${(Math.max(0, end - start) / width) * 100}%`,
    };
  };
  return (
    <div aria-hidden className="relative mt-2 h-3 w-full overflow-hidden rounded-full bg-charcoal-800/60">
      {day.hours.map((s) => (
        <span key={`h${s.start}`} className="absolute inset-y-0 bg-emerald-soft/25" style={place(s)} />
      ))}
      {day.off.map((s) => (
        <span
          key={`o${s.start}`}
          className="absolute inset-y-0 bg-charcoal-700 [background-image:repeating-linear-gradient(135deg,transparent_0_3px,rgb(var(--cb-fg)/0.12)_3px_5px)]"
          style={place(s)}
        />
      ))}
      {day.booked.map((s) => (
        <span key={`b${s.start}`} className="absolute inset-y-0 bg-gold/70" style={place(s)} />
      ))}
    </div>
  );
}

/** The key under a set of bars. */
export function ScheduleKey() {
  const item = (cls: string, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("inline-block h-2.5 w-4 rounded-sm", cls)} />
      {text}
    </span>
  );
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
      {item("bg-emerald-soft/25", "Free")}
      {item("bg-gold/70", "Booked")}
      {item("bg-charcoal-700", "Off")}
    </p>
  );
}
