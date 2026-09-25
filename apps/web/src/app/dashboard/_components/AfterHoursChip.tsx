import { cn } from "@/lib/cn";

/**
 * "After hours": this booking was made INTO one of the barber's specials (a
 * targeted slot he published outside regular hours), so it sits by the
 * client's name wherever he reads it. Drick: "When they book the targeted
 * slots in the name it should say after hour so i know it".
 *
 * Driven only by the row's `afterHours` flag, which the agenda derives from
 * the booking's write-time origin marker. Display only - the name is untouched.
 * `className` carries each surface's chip padding so it matches its siblings.
 */
export function AfterHoursChip({ className }: { className?: string }) {
  return (
    <span
      data-testid="after-hours-chip"
      title="Booked into one of your specials (targeted slots)"
      className={cn(
        "shrink-0 rounded-full bg-indigo-400/15 text-[10px] font-medium text-indigo-300",
        className ?? "px-1.5 py-0.5",
      )}
    >
      After hours
    </span>
  );
}
