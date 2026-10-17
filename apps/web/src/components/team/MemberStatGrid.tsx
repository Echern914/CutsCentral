"use client";

import { cn } from "@/lib/cn";
import type { Change, TeamStat } from "@/lib/teamNumbers";

/**
 * A team member's numbers as the shop's owner sees them: "Hidden" for what
 * isn't shared, and a change against the window before for what is.
 *
 * 🔴 ONE COMPONENT, TWO PAGES. The owner's Team card renders it, and so does
 * the member's own "how your row looks" preview - so the preview cannot show
 * the barber anything other than what the owner actually sees.
 */
export function MemberStatGrid({ stats, qa }: { stats: TeamStat[]; qa?: string }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-qa={qa}>
      {stats.map((s) => (
        <div key={s.key} className="min-w-0 rounded-lg bg-charcoal-800/60 px-3 py-2">
          <dt className="truncate text-[11px] uppercase tracking-wide text-muted">{s.label}</dt>
          <dd
            className={cn(
              "mt-0.5 text-sm tabular-nums [overflow-wrap:anywhere]",
              s.value === null ? "text-muted" : "font-semibold text-offwhite",
            )}
          >
            {s.value ?? "Hidden"}
          </dd>
          {s.change && <ChangeTag change={s.change} />}
        </div>
      ))}
    </dl>
  );
}

/** "↑ 18%" in green, "↓ 5%" in rose, "Same" quiet. */
export function ChangeTag({ change }: { change: Change }) {
  return (
    <p
      className={cn(
        "mt-0.5 text-[11px] font-medium tabular-nums",
        change.trend === "up" ? "text-emerald-soft" : change.trend === "down" ? "text-danger-soft" : "text-muted",
      )}
    >
      {change.text}
    </p>
  );
}
