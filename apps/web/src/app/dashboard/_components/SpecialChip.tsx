import { cn } from "@/lib/cn";

/**
 * The chip by the client's name when the booking was made INTO one of the
 * barber's specials (targeted slots). Drick: "When they book the targeted
 * slots in the name it should say after hour so i know it".
 *
 * It says "After hours" only when the special starts outside his regular
 * hours - the API decides that against his weekly hours - and "Special" for a
 * daytime one (a lunch special, a morning rate): a 2 PM booking labelled
 * "After hours" would be false. Display only - the name is untouched.
 *
 * Colour is the `indigo-soft` theme token, not a raw palette class: a raw
 * indigo-300 stays pale lavender on the light theme's white cards (~1.7:1),
 * which would hide the one thing this chip is for.
 * `className` carries each surface's chip padding so it matches its siblings.
 */
export function SpecialChip({
  afterHours,
  className,
}: {
  afterHours?: boolean;
  className?: string;
}) {
  return (
    <span
      data-testid="special-chip"
      title="Booked into one of your specials"
      className={cn(
        "shrink-0 rounded-full bg-indigo-soft/15 text-[10px] font-medium text-indigo-soft",
        className ?? "px-1.5 py-0.5",
      )}
    >
      {afterHours ? "After hours" : "Special"}
    </span>
  );
}
