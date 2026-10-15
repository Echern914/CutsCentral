/**
 * MAY THE CLIENT CHANGE THIS BOOKING THEMSELVES? ONE RULE, BOTH ACTIONS.
 *
 * A shop decides, separately for moving and for cancelling:
 *  - whether clients may do it online at all (`Shop.customerCanReschedule`,
 *    `Shop.customerCanCancel`), and
 *  - how close to the start they may still do it (`Shop.rescheduleCutoffHours`,
 *    `Shop.cancelCutoffHours`; 0 = until the appointment starts).
 *
 * "Online" means every way a client changes a booking without the barber: the
 * manage link, the group link, and a text to the receptionist. The barber
 * changes anything, any time, from the dashboard - nothing here applies there.
 *
 * Refused, the client is told who to contact. Never a fee: whether cancelling
 * costs money is the Payments setting (cancelWindowHours / cancelFeeBps), and
 * this rule only decides whether the client may do it themselves.
 *
 * Boundary: exactly `cutoffHours` before the start is still allowed; one
 * millisecond inside is refused (the same as config/rescheduleCutoff.ts).
 * Hours that are not a positive number (0, NaN, negative) mean "no cutoff" -
 * a bad number never locks a client out. The ALLOW flag is the opposite: only
 * `true` allows; anything else is "disabled".
 *
 * Pure: no I/O, no clock - callers pass `now`. Imported by client components.
 */
import {
  describeReschedulePolicy,
  formatCutoffHours,
  rescheduleClosedMessage,
} from "./rescheduleCutoff.js";

export type CustomerChangeAction = "reschedule" | "cancel";

export type CustomerChangeVerdict =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "cutoff"; message: string };

/** A week, the same ceiling as the reschedule cutoff. */
export const CANCEL_CUTOFF_MAX_HOURS = 168;
/** Until the shop chooses: a client may cancel until the start (today's behavior). */
export const DEFAULT_CANCEL_CUTOFF_HOURS = 0;

/** True when `now` is inside the cutoff. Hours that aren't > 0 never close. */
function insideCutoff(startsAt: Date, now: Date, cutoffHours: number): boolean {
  if (!(cutoffHours > 0)) return false;
  return startsAt.getTime() - now.getTime() < cutoffHours * 3_600_000;
}

/** When online changes of this kind close for this booking, or null when never. */
export function customerChangeClosesAt(startsAt: Date, cutoffHours: number): Date | null {
  if (!(cutoffHours > 0)) return null;
  return new Date(startsAt.getTime() - cutoffHours * 3_600_000);
}

/** What the client reads when the shop takes no such change online at all. */
export function customerChangeDisabledMessage(
  action: CustomerChangeAction,
  shopName: string,
): string {
  return action === "reschedule"
    ? `${shopName} doesn't take reschedules online. To move your appointment, contact ${shopName} directly.`
    : `${shopName} doesn't take cancellations online. To cancel your appointment, contact ${shopName} directly.`;
}

/** What the client reads once it is too close to the start to do it themselves. */
export function customerChangeCutoffMessage(
  action: CustomerChangeAction,
  cutoffHours: number,
  shopName: string,
): string {
  // The reschedule sentence already shipped (#637); kept word for word.
  if (action === "reschedule") return rescheduleClosedMessage(cutoffHours, shopName);
  return `${shopName} takes cancellations online up to ${formatCutoffHours(
    cutoffHours,
  )} before your appointment. To cancel now, contact ${shopName} directly.`;
}

/**
 * THE rule. May a client make this change themselves right now?
 * Disabled wins over the cutoff (the client should hear "not online at all",
 * not "too late", when both are true).
 */
export function customerChange(input: {
  action: CustomerChangeAction;
  allowed: boolean;
  cutoffHours: number;
  startsAt: Date;
  now: Date;
  shopName: string;
}): CustomerChangeVerdict {
  if (input.allowed !== true) {
    return {
      allowed: false,
      reason: "disabled",
      message: customerChangeDisabledMessage(input.action, input.shopName),
    };
  }
  if (insideCutoff(input.startsAt, input.now, input.cutoffHours)) {
    return {
      allowed: false,
      reason: "cutoff",
      message: customerChangeCutoffMessage(input.action, input.cutoffHours, input.shopName),
    };
  }
  return { allowed: true };
}

/**
 * The rule in words, for a policy line (the receptionist's prompt): who may
 * do it, and until when.
 */
export function describeCustomerChangePolicy(
  action: CustomerChangeAction,
  allowed: boolean,
  cutoffHours: number,
): string {
  const verb = action === "reschedule" ? "move" : "cancel";
  if (allowed !== true) {
    return `clients can't ${verb} an appointment themselves (online or by text) - only the shop can`;
  }
  // The reschedule line already shipped (#637) - the prompt keeps its words.
  if (action === "reschedule") return describeReschedulePolicy(cutoffHours);
  return cutoffHours > 0
    ? `clients can ${verb} it themselves up to ${formatCutoffHours(cutoffHours)} before; after that only the shop can`
    : `clients can ${verb} it themselves any time before the appointment`;
}

/** The settings form and the settings API: a whole number of hours in range. */
export function isValidCancelCutoff(hours: unknown): hours is number {
  return (
    typeof hours === "number" &&
    Number.isInteger(hours) &&
    hours >= 0 &&
    hours <= CANCEL_CUTOFF_MAX_HOURS
  );
}
