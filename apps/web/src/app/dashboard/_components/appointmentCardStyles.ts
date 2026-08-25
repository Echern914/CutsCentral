/**
 * The shared visual language for appointment cards - booking day view, the
 * dashboard's Today agenda, and a client's Upcoming list all speak it:
 *
 *   - The CLIENT'S NAME is the focus: semibold, its own full-width block,
 *     wrapping naturally. NEVER truncated - "Ab…" cost barbers the one fact
 *     the card exists to show. [overflow-wrap:anywhere] is the safety net for
 *     unbroken 40-character names at 320px.
 *   - Time and status stay quiet and structural; service details ride in a
 *     muted secondary line.
 *
 * Presentation only. Statuses, permissions and action handlers are untouched
 * by design - this module owns no behavior.
 */

/** Full-name block: wraps anywhere, never ellipsizes. Size set per surface. */
export const NAME_WRAP_CLS =
  "min-w-0 [overflow-wrap:anywhere] font-semibold leading-snug text-offwhite";

/**
 * Up to two initials for the little avatar circle. Unicode-aware ([...] not
 * charCodeAt), so "José María" -> "JM" and "王小明" -> "王".
 */
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // A generational suffix is not a name: "Blackwood III" must not read "AI".
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }
  if (words.length === 0) return "•";
  const first = [...words[0]!][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]!][0] ?? "") : "";
  return (first + second).toUpperCase() || "•";
}

/**
 * One action button, everywhere: a 44px mobile touch target that relaxes to
 * 36px once there is room, with identical radius and weight across surfaces.
 * Color/role is layered on by the caller (gold primary, green done, red
 * destructive, neutral secondary) so the SHAPE can never drift between the
 * appointment card and the waitlist board.
 */
export const BTN_BASE =
  "flex h-11 w-full items-center justify-center rounded-lg px-3 text-xs font-medium transition-colors disabled:opacity-50 sm:h-9";

/** The booking states a card or sheet can show. `blocked` is not a booking. */
export type AppointmentCardStatus =
  | "pending"
  | "upcoming"
  | "completed"
  | "canceled"
  | "no_show"
  | "blocked";

/**
 * THE BOOKING STATE, SAID PLAINLY - and said the SAME WAY everywhere.
 *
 * "Upcoming" answered the wrong question: it described WHEN, so a barber
 * reading a card could not tell an accepted booking from a request still
 * waiting on them. Requested and Booked are different commitments and read
 * differently.
 *
 * This is SOURCE-BLIND on purpose. Where a booking came from (ChairBack vs
 * Acuity) is a separate fact with its own badge, because a synced booking is
 * just as booked as a native one - collapsing the two into one chip is what
 * made "Synced" read like a status in the first place.
 *
 * Lives here rather than in the calendar because the appointment SHEET shows
 * the same pill: two copies of this table would eventually disagree about what
 * "Arrived" looks like, on the one surface where a barber compares them.
 *
 * `railCls` tints the sheet's thin status rail from the same source, so the
 * rail and the pill can never describe two different states.
 */
export function appointmentStatusPill(input: {
  status: AppointmentCardStatus;
  checkInStatus?: "en_route" | "arrived" | null;
  etaMinutes?: number | null;
  runningLate?: boolean;
}): { label: string; cls: string; railCls: string } {
  // Check-in refines a BOOKED appointment into the live pill the barber
  // watches on the day (Booked -> En route -> Arrived).
  if (input.status === "upcoming" && input.checkInStatus === "arrived") {
    return {
      label: "Arrived",
      cls: "bg-emerald-soft/15 text-emerald-soft",
      railCls: "bg-emerald-soft/70",
    };
  }
  if (input.status === "upcoming" && input.checkInStatus === "en_route") {
    return {
      label: input.runningLate
        ? "En route · late"
        : input.etaMinutes
          ? `En route ~${input.etaMinutes}m`
          : "En route",
      cls: "bg-amber-400/15 text-amber-300",
      railCls: "bg-amber-400/70",
    };
  }
  return STATUS_PILL[input.status];
}

const STATUS_PILL: Record<
  AppointmentCardStatus,
  { label: string; cls: string; railCls: string }
> = {
  pending: {
    label: "Requested",
    cls: "bg-amber-400/15 text-amber-300",
    railCls: "bg-amber-400/70",
  },
  upcoming: { label: "Booked", cls: "bg-gold/15 text-gold", railCls: "bg-gold/70" },
  completed: {
    label: "Completed",
    cls: "bg-emerald-soft/15 text-emerald-soft",
    railCls: "bg-emerald-soft/70",
  },
  canceled: {
    label: "Canceled",
    cls: "bg-danger-soft/15 text-danger-soft",
    railCls: "bg-danger-soft/60",
  },
  no_show: {
    label: "No-show",
    cls: "bg-danger-soft/15 text-danger-soft",
    railCls: "bg-danger-soft/60",
  },
  blocked: {
    label: "Blocked",
    cls: "bg-charcoal-700 text-muted",
    railCls: "bg-charcoal-600",
  },
};
