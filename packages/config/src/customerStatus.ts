/**
 * WHAT A CUSTOMER IS TOLD ABOUT AN APPOINTMENT - decided in ONE place.
 *
 * A customer sees five states and only five: Requested, Booked, Completed,
 * Canceled, No-show. Two tables feed them, and each speaks its own dialect:
 *
 *   Appointment (native ChairBack bookings)
 *     PENDING   -> requested   awaiting the shop's approval, a payment hold
 *                              that hasn't settled, or a receptionist hold
 *     BOOKED    -> booked
 *     COMPLETED -> completed
 *     CANCELED  -> canceled
 *     NO_SHOW   -> no_show
 *
 *   Visit (Acuity / Square / hand-logged visits)
 *     SCHEDULED, RESCHEDULED -> booked       (a reschedule edits the time;
 *                                             it is still on the books)
 *     COMPLETED -> completed
 *     CANCELED  -> canceled
 *     NO_SHOW   -> no_show
 *
 * 🔴 WHY THIS EXISTS. The customer's manage page used to compute its own label
 * and printed "Confirmed" for everything that wasn't canceled or completed -
 * which included approval requests the barber had not seen yet and payment
 * holds that were about to lapse - and "Completed" for a no-show. A customer
 * told "Confirmed" shows up for a slot nobody agreed to. PENDING is NEVER
 * booked, and nothing that renders a status for a customer may decide that
 * for itself.
 *
 * Both mappers are exhaustive switches over the database enums, so a new
 * status value fails the BUILD here instead of falling through to a guess on a
 * customer's screen.
 */

export const CUSTOMER_STATUSES = [
  "requested",
  "booked",
  "completed",
  "canceled",
  "no_show",
] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** The exact words a customer reads. Sentence case, no shouting. */
export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  requested: "Requested",
  booked: "Booked",
  completed: "Completed",
  canceled: "Canceled",
  no_show: "No-show",
};

/** Mirrors the Prisma `AppointmentStatus` enum (config cannot import the DB client). */
export type AppointmentStatusValue =
  | "PENDING"
  | "BOOKED"
  | "CANCELED"
  | "COMPLETED"
  | "NO_SHOW";

/** Mirrors the Prisma `VisitStatus` enum. */
export type VisitStatusValue =
  | "SCHEDULED"
  | "RESCHEDULED"
  | "COMPLETED"
  | "CANCELED"
  | "NO_SHOW";

export function customerStatusForAppointment(status: AppointmentStatusValue): CustomerStatus {
  switch (status) {
    case "PENDING":
      return "requested";
    case "BOOKED":
      return "booked";
    case "COMPLETED":
      return "completed";
    case "CANCELED":
      return "canceled";
    case "NO_SHOW":
      return "no_show";
    default:
      return assertNever(status);
  }
}

export function customerStatusForVisit(status: VisitStatusValue): CustomerStatus {
  switch (status) {
    case "SCHEDULED":
    case "RESCHEDULED":
      return "booked";
    case "COMPLETED":
      return "completed";
    case "CANCELED":
      return "canceled";
    case "NO_SHOW":
      return "no_show";
    default:
      return assertNever(status);
  }
}

/**
 * Why a Requested appointment is still a request. PENDING carries three
 * meanings and only the hold columns tell them apart (see the schema comment on
 * `Appointment.holdReason`):
 *
 *   holdReason "payment"            -> the customer hasn't finished paying
 *   holdExpiresAt set, no reason    -> the AI receptionist is holding it mid-text
 *   neither                         -> waiting for the shop to approve it
 */
export type RequestedReason = "approval" | "payment" | "arranging";

export function requestedReason(hold: {
  holdReason: string | null;
  holdExpiresAt: Date | string | null;
}): RequestedReason {
  if (hold.holdReason === "payment") return "payment";
  if (hold.holdExpiresAt !== null) return "arranging";
  return "approval";
}

/**
 * The one line under "Requested", naming who the customer is waiting on.
 *
 * 🔴 "payment" SAYS "NOT BOOKED". It used to say "Payment not finished", and
 * customers read the appointment above it as theirs: they had picked the time
 * and seen it on their list, so they left - and the hold ran out ten minutes
 * later with the time back on sale. `until` is the deadline, already in the
 * shop's own time ("1:04 PM"), when the caller has it.
 */
export function requestedDetail(
  reason: RequestedReason,
  shopName: string,
  opts: { until?: string | null } = {},
): string {
  switch (reason) {
    case "approval":
      return `Waiting for ${shopName} to confirm`;
    case "payment":
      return opts.until
        ? `Not booked yet: finish checkout by ${opts.until}`
        : "Not booked yet: checkout isn't finished";
    case "arranging":
      return `Being arranged by text with ${shopName}`;
    default:
      return assertNever(reason);
  }
}

/**
 * What the app says about a time the customer is holding while they save a
 * card or pay - a live `holdReason: "payment"` hold.
 *
 * 🔴 NOT "REQUESTED". Customers left the card step (the app's own Done, or a
 * browser closed seconds after Confirm), opened the app, saw "Requested" and
 * read it as booked: "Did I do this right?" Nothing is booked until the card
 * is saved, so the label says so, the line gives the deadline, and the note
 * names the one way to finish.
 *
 * `note` names "Reschedule" because that is the app's own button - it opens
 * the appointment's manage page, which for a live hold is the card step and
 * nothing else. A shipped build's buttons are fixed words; this sentence is
 * how they point at the right one without an App Store update.
 *
 * `paymentsMode` picks the verb: a card on file is saved, never charged here;
 * a deposit or an ahead payment is paid. `until` is already in the shop's own
 * time ("10:21 PM"), when the caller has it.
 */
export function unfinishedHoldCopy(
  paymentsMode: string | null,
  until: string | null,
): { label: string; detail: string; note: string } {
  const act =
    paymentsMode === "card_on_file" ? "save your card" : paymentsMode === "deposit" ? "pay the deposit" : "pay";
  const Act = act[0]!.toUpperCase() + act.slice(1);
  return {
    label: "Not booked yet",
    detail: until ? `${Act} by ${until} to book this time.` : `${Act} to book this time.`,
    note: `To finish, tap Reschedule and ${act}.`,
  };
}

/**
 * Whether a status still belongs in "Upcoming". A requested or booked visit in
 * the future is upcoming; everything else is history, whatever its date.
 */
export function isUpcomingStatus(status: CustomerStatus): boolean {
  return status === "requested" || status === "booked";
}

function assertNever(value: never): never {
  throw new Error(`unhandled status: ${String(value)}`);
}
