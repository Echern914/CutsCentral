"use server";

import { revalidatePath } from "next/cache";
import type { BookingModeKey } from "@chairback/config/constants";
import { apiGet, apiSend } from "@/lib/api";
import type { AgendaResponse } from "./page";

type Result = { ok: boolean; error?: string };

/**
 * Load the normalized agenda for a date range (the month calendar calls this
 * when the barber pages to a different month). from/to are ISO instants.
 */
export async function getAgendaAction(
  from: string,
  to: string,
): Promise<{ ok: boolean; data?: AgendaResponse; error?: string }> {
  const res = await apiGet<AgendaResponse>(
    `/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

export interface RecurringBlockRow {
  id: string;
  weekday: number;
  startMin: number;
  endMin: number;
  reason: string | null;
}
export interface AvailabilityData {
  rules: { id: string; weekday: number; startMin: number; endMin: number }[];
  recurringBlocks: RecurringBlockRow[];
  exceptions: {
    id: string;
    startsAt: string;
    endsAt: string;
    isBlock: boolean;
    reason: string | null;
  }[];
  /**
   * Weekdays (0=Sun) on which not one of this person's services is offered.
   * Turning such a day on here changes nothing a customer can see — the
   * service's own hours veto it — so the editor says so instead of letting the
   * barber believe a ticked box is enough.
   */
  weekdaysWithNoService?: number[];
}

/** Load a staff member's weekly availability + upcoming exceptions. */
export async function getAvailabilityAction(
  staffId: string,
): Promise<{ ok: boolean; data?: AvailabilityData; error?: string }> {
  const res = await apiGet<AvailabilityData>(
    `/api/booking/staff/${staffId}/availability`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

function done(res: { ok: boolean; error?: string }): Result {
  if (res.ok) revalidatePath("/dashboard/booking");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

//  Booking mode + bounds (patches the shop)

export async function saveBookingSettingsAction(input: {
  bookingMode: BookingModeKey;
  bookingUrl?: string;
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
  slotOpenedTextsEnabled?: boolean;
  requireBookingApproval?: boolean;
  bookingGroupsFirst?: boolean;
  pushReminder24hEnabled?: boolean;
  pushReminder2hEnabled?: boolean;
}): Promise<Result> {
  return done(await apiSend("PATCH", "/api/shops/me", input));
}

//  Staff

export async function createStaffAction(input: {
  name: string;
  bio?: string;
  imageUrl?: string;
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/staff", input));
}

export async function updateStaffAction(
  id: string,
  input: { name?: string; bio?: string; imageUrl?: string; active?: boolean },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/staff/${id}`, input));
}

export async function deleteStaffAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/staff/${id}`));
}

//  Services

// Per-weekday available-hours restriction ({ "1": [{ s, e }] } minutes from
// shop-local midnight). Weekday absent = unrestricted; [] = closed that day.
type ServiceHoursWindows = Record<string, { s: number; e: number }[]>;

// Time-of-day price/duration window ([{s,e,price?,durationMin?}] in shop-local
// minutes, e exclusive, every day) - "after 9 PM this runs $65 and takes 20
// min". Layered over the per-weekday overrides; must not overlap (API 400s).
export type ServiceTimeWindow = {
  s: number;
  e: number;
  price?: number | null;
  durationMin?: number | null;
};

export async function createServiceAction(input: {
  name: string;
  description?: string;
  imageUrl?: string;
  durationMin: number;
  durationOverrides?: Record<string, number>;
  dailyLimits?: Record<string, number>;
  hoursWindows?: ServiceHoursWindows;
  timeOverrides?: ServiceTimeWindow[];
  price?: number | null;
  priceOverrides?: Record<string, number>;
  dateOverrides?: Record<string, number>;
  color?: string | null;
  // Display-only daily slot target for the calendar day gauge. NOT a cap, and
  // only used while the service is ungrouped (a grouped one uses its group's).
  dailyTarget?: number | null;
  offeredByAll?: boolean;
  staffIds?: string[];
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/services", input));
}

export async function updateServiceAction(
  id: string,
  input: {
    name?: string;
    description?: string;
    imageUrl?: string;
    durationMin?: number;
    durationOverrides?: Record<string, number>;
  dailyLimits?: Record<string, number>;
    hoursWindows?: ServiceHoursWindows;
    timeOverrides?: ServiceTimeWindow[];
    price?: number | null;
    priceOverrides?: Record<string, number>;
    dateOverrides?: Record<string, number>;
    active?: boolean;
    color?: string | null;
    dailyTarget?: number | null;
    offeredByAll?: boolean;
    staffIds?: string[];
  },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/services/${id}`, input));
}

export async function deleteServiceAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/services/${id}`));
}

//  Service groups

// A group bundles several services under ONE shared set of booking limits.
// maxPerDay = total bookings/shop-local-day across all members; maxConcurrent =
// overlapping bookings at once across the group. Either cap null = no limit.
// serviceIds = the group's current membership. Hours are NOT here - they belong
// to the service (Services -> Edit); the API rejects hoursWindows on a group.
export interface ServiceGroupInput {
  name: string;
  maxPerDay?: number | null;
  maxConcurrent?: number | null;
  // Display-only daily slot target for the calendar day gauge ("Haircuts 10/12").
  // NOT a cap - booking past it is allowed and just reads 13/12.
  dailyTarget?: number | null;
  serviceIds?: string[];
  active?: boolean;
  sortOrder?: number;
}

export async function createServiceGroupAction(
  input: ServiceGroupInput,
): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/groups", input));
}

export async function updateServiceGroupAction(
  id: string,
  input: Partial<ServiceGroupInput>,
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/groups/${id}`, input));
}

export async function deleteServiceGroupAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/groups/${id}`));
}

//  Availability

export async function saveAvailabilityAction(
  staffId: string,
  rules: { weekday: number; startMin: number; endMin: number }[],
  recurringBlocks: {
    weekday: number;
    startMin: number;
    endMin: number;
    reason?: string;
  }[] = [],
): Promise<Result> {
  return done(
    await apiSend("PUT", `/api/booking/staff/${staffId}/availability`, {
      rules,
      recurringBlocks,
    }),
  );
}

//  Connect / disconnect booking platforms

/** Disconnect Acuity: tears down webhooks + deletes the stored token. Visits kept. */
export async function disconnectAcuityAction(): Promise<Result> {
  return done(await apiSend("POST", "/api/acuity/oauth/disconnect"));
}

/** Disconnect Square: deletes the stored token. Visits kept. */
export async function disconnectSquareAction(): Promise<Result> {
  return done(await apiSend("POST", "/api/square/oauth/disconnect"));
}

//  Acuity calendar mapping (which Acuity calendar is which chair)

export interface AcuityCalendarOption {
  id: string;
  name: string | null;
  /** Another chair already owns this calendar - one calendar, one chair. */
  takenByStaffId: string | null;
}
export interface AcuityStaffMapping {
  id: string;
  name: string;
  active: boolean;
  bookable: boolean;
  calendarId: string | null;
  calendarName: string | null;
  /**
   * Other calendars this SAME chair is sold on - only for Acuity accounts that
   * split one barber across several service-named calendars. One booking
   * blocks every one of them.
   */
  extraCalendarIds: string[];
  /** null = fine. "unmapped" | "stale" | "invalid" | "extra_invalid". */
  problem: string | null;
}
export interface AcuityMappingData {
  mode: "OFF" | "OBSERVE" | "ENFORCE";
  bookingMode: string;
  ready: boolean;
  preselectCalendarId: string | null;
  /** Connection generation this snapshot was taken against; echoed on save. */
  connectedAt: string | null;
  calendars: AcuityCalendarOption[];
  staff: AcuityStaffMapping[];
}

/** Live calendars + current per-chair mapping + enforcement readiness. */
export async function getAcuityMappingAction(): Promise<{
  ok: boolean;
  data?: AcuityMappingData;
  error?: string;
}> {
  const res = await apiGet<AcuityMappingData>("/api/booking/acuity/calendars");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

/** Point one chair at one Acuity calendar (null clears it). */
export async function setStaffAcuityCalendarAction(
  staffId: string,
  calendarId: string | null,
  connectedAt: string | null,
): Promise<Result> {
  const res = await apiSend(
    "PUT",
    `/api/booking/staff/${encodeURIComponent(staffId)}/acuity-calendar`,
    { calendarId, connectedAt },
  );
  revalidatePath("/dashboard/booking");
  return done(res);
}

/**
 * The OTHER calendars this one chair is sold on (empty clears them).
 *
 * Only accounts that run one barber across several service-named calendars
 * need this: an Acuity block is calendar-scoped, so blocking the primary alone
 * leaves the same hour bookable on every other one.
 */
export async function setStaffAcuityExtraCalendarsAction(
  staffId: string,
  calendarIds: string[],
  connectedAt: string | null,
): Promise<Result> {
  const res = await apiSend(
    "PUT",
    `/api/booking/staff/${encodeURIComponent(staffId)}/acuity-extra-calendars`,
    { calendarIds, connectedAt },
  );
  revalidatePath("/dashboard/booking");
  return done(res);
}

//  New Appointment (barber-side) + Block Off Time (native booking)

export interface DashSlot {
  startsAt: string;
  endsAt: string;
}

/**
 * One of the barber's own targeted slots (a "special"), offered in his New
 * appointment picker. Its length and price are its OWN, not the service's -
 * which is why it is a separate list rather than more chips in the grid.
 */
export interface DashSpecial {
  id: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  price: number;
  label: string | null;
}

/**
 * Open slots for a (staff, service) over a range - powers the Time picker -
 * plus the barber's specials under that service. Older API responses carry no
 * `targetedSlots`, which reads as none.
 */
export async function getDashSlotsAction(
  staffId: string,
  serviceId: string,
  from: string,
  to: string,
): Promise<{
  ok: boolean;
  slots?: DashSlot[];
  specials?: DashSpecial[];
  timezone?: string;
  error?: string;
}> {
  const qs = new URLSearchParams({ staffId, serviceId, from, to }).toString();
  const res = await apiGet<{
    timezone: string;
    slots: DashSlot[];
    targetedSlots?: DashSpecial[];
  }>(`/api/booking/slots?${qs}`);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return {
    ok: true,
    slots: res.data.slots,
    specials: res.data.targetedSlots ?? [],
    timezone: res.data.timezone,
  };
}

export interface ClientOption {
  id: string;
  /**
   * The COMBINED display name ("Jordan D.") - which is what GET
   * /api/dashboard/clients actually sends. This interface originally declared
   * firstName/lastName, fields that endpoint has never returned in the life of
   * the platform, so every picker row rendered its fallback: a bare phone
   * number, or the literal word "Client". The search itself always worked -
   * typing a name found the right rows - they just came back nameless, which
   * reads as "names don't come up". (Only the client DETAIL endpoint sends
   * first/last; the list deliberately sends the display shape.)
   */
  name: string | null;
  phone: string | null;
}

/** Search the shop's clients for the Client picker (reuses the clients list). */
export async function searchClientsAction(
  q: string,
): Promise<{ ok: boolean; clients?: ClientOption[]; error?: string }> {
  const res = await apiGet<{ clients: ClientOption[] }>(
    `/api/dashboard/clients?q=${encodeURIComponent(q)}`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, clients: res.data.clients };
}

export interface CreateApptInput {
  staffId: string;
  serviceId: string;
  startsAt: string;
  clientId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  note?: string;
  customTime?: boolean;
  /**
   * Answers a refusal: the `confirmation` digest the API sent with an
   * `external_block` 409, replayed after the barber chose to go ahead. It
   * authorises the exact blocks that refusal named - if the conflict has
   * changed since, the API refuses again with the new one. Every confirmed
   * override is recorded server-side.
   */
  externalBlockConfirmation?: string;
  /**
   * Custom time only: book over the bookings / visits / own specials a previous
   * `slot_taken` (code OVERLAP) named - its `confirmation`, replayed. Bound to
   * exactly those rows; anything new in the way is asked about again.
   */
  overlapConfirmation?: string;
  /**
   * Booking someone off the waitlist: the entry flips to BOOKED and takes
   * bookedAppointmentId INSIDE the same transaction that creates the
   * appointment, so a half-linked state cannot exist.
   */
  waitlistEntryId?: string;
  /**
   * Booking INTO one of the barber's specials. The server claims the slot in
   * the same transaction (as the website does) and books it at the special's
   * own length and price. Never combined with `recurrence`.
   */
  targetedSlotId?: string;
  // "Repeats every N weeks" — exactly one of count / until. Server generates the
  // occurrences and returns a series summary (booked + any skipped dates).
  recurrence?: {
    interval: number;
    count?: number;
    until?: string; // ISO
  };
}

export interface SeriesSummary {
  id: string;
  booked: number;
  skipped: { startsAt: string; reason: string }[];
}

export type CreateApptResult = Result & {
  series?: SeriesSummary;
  /** For `external_block`: the block, in words, in the shop's zone. */
  reason?: string;
  /** For `external_block` / OVERLAP: what to send back to confirm THAT conflict. */
  confirmation?: string;
  /** The API's classification - `OVERLAP` marks a confirmable slot_taken. */
  code?: string;
  /** For OVERLAP: what the time sits on, one line each, in the shop's zone. */
  conflicts?: string[];
};

export async function createAppointmentAction(
  input: CreateApptInput,
): Promise<CreateApptResult> {
  const res = await apiSend<{ series?: SeriesSummary }>(
    "POST",
    "/api/booking/appointments",
    input,
  );
  if (res.ok) revalidatePath("/dashboard/booking");
  if (!res.ok) {
    return {
      ok: false,
      error: res.error ?? "failed",
      ...(res.reason ? { reason: res.reason } : {}),
      ...(res.confirmation ? { confirmation: res.confirmation } : {}),
      ...(res.code ? { code: res.code } : {}),
      ...(res.conflicts ? { conflicts: res.conflicts } : {}),
    };
  }
  return { ok: true, series: res.data?.series };
}

/** Approve a PENDING request → BOOKED (fires the customer confirmation). */
export async function approveAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/approve`));
}

/** Decline a PENDING request → CANCELED (light flip, no refund/clawback). */
export async function declineAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/decline`));
}

/**
 * Cancel a recurring series by scope. "this"/"future" need the anchor
 * occurrence's appointment id; "all" cancels every still-booked occurrence.
 */
export async function cancelSeriesAction(
  seriesId: string,
  scope: "this" | "future" | "all",
  fromAppointmentId?: string,
): Promise<Result> {
  return done(
    await apiSend("POST", `/api/booking/series/${seriesId}/cancel`, {
      scope,
      ...(fromAppointmentId ? { fromAppointmentId } : {}),
    }),
  );
}

//  Service add-ons

export interface AddOnInput {
  name: string;
  durationMin: number;
  price?: number | null;
  // [] = offered on every service; non-empty = only with those services.
  serviceIds?: string[];
  active?: boolean;
  sortOrder?: number;
}

export async function createAddOnAction(input: AddOnInput): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/addons", input));
}

export async function updateAddOnAction(
  id: string,
  input: Partial<AddOnInput>,
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/addons/${id}`, input));
}

export async function deleteAddOnAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/addons/${id}`));
}

/**
 * BOOKING QUESTIONS - what the shop asks a customer before it can do the job.
 *
 * The kind list is the one in the database enum and in packages/config; a test
 * holds all three together (apps/api engines/bookingIntake.test.ts).
 */
export type BookingQuestionKind =
  | "text"
  | "textarea"
  | "address"
  | "select"
  | "phone"
  | "email"
  | "number";

export interface BookingQuestionInput {
  label?: string;
  helpText?: string | null;
  kind?: BookingQuestionKind;
  required?: boolean;
  options?: string[];
  /** [] = asked on every service; non-empty = only those. */
  serviceIds?: string[];
  sortOrder?: number;
  active?: boolean;
}

export async function createBookingQuestionAction(
  input: BookingQuestionInput,
): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/questions", input));
}

export async function updateBookingQuestionAction(
  id: string,
  input: BookingQuestionInput,
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/questions/${id}`, input));
}

export async function deleteBookingQuestionAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/questions/${id}`));
}

/**
 * Add the suggested questions for this shop's business type. Idempotent - a
 * second tap adds nothing - so the button is safe to press again, and returns
 * how many were actually added so the page can say something true.
 */
export async function seedBookingQuestionsAction(): Promise<Result & { added?: number }> {
  const res = await apiSend<{ added: number }>("POST", "/api/booking/questions/seed");
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, added: res.data?.added ?? 0 };
}

/**
 * Block off time, two ways. `timed` carries the two instants the form already
 * converted through the SHOP's zone; `days` carries shop-local day keys and
 * lets the API resolve every midnight itself - a whole day is a statement
 * about the calendar, not about two instants, and the API is the one place
 * that knows the zone for certain. Both take the `confirmation` a previous
 * `appointments_overlap` refusal handed back.
 */
export type BlockOffInput =
  | {
      kind: "timed";
      staffId: string;
      startsAt: string; // ISO
      endsAt: string; // ISO
      reason?: string;
      confirmation?: string;
    }
  | {
      kind: "days";
      staffId: string;
      fromDate: string; // YYYY-MM-DD, shop-local
      toDate: string; // YYYY-MM-DD, shop-local, inclusive
      /**
       * The same hours on EVERY day of the range, as shop-local minutes from
       * midnight (end exclusive). Absent = all day on each day. The API turns
       * each day into its own row either way.
       */
      window?: { fromMin: number; toMin: number };
      reason?: string;
      confirmation?: string;
    };

export interface BlockOffResult extends Result {
  /** The API's headline for a refusal it can be talked past. */
  reason?: string;
  /** One line per booking the block would sit on, in the shop's zone. */
  conflicts?: string[];
  /** The digest that authorises blocking over exactly those bookings. */
  confirmation?: string;
  /** How many rows the block became (one per day for a day range). */
  created?: number;
}

/**
 * Block off time (native). Same staff-exceptions endpoint as always; the
 * `appointments_overlap` refusal is passed through whole so the form can show
 * the bookings and offer to block anyway - the bookings themselves are never
 * touched by this call.
 */
export async function addBlockAction(input: BlockOffInput): Promise<BlockOffResult> {
  const body =
    input.kind === "days"
      ? {
          fromDate: input.fromDate,
          toDate: input.toDate,
          ...(input.window
            ? { fromMin: input.window.fromMin, toMin: input.window.toMin }
            : { allDay: true as const }),
          reason: input.reason,
          confirmation: input.confirmation,
        }
      : {
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          isBlock: true,
          reason: input.reason,
          confirmation: input.confirmation,
        };
  const res = await apiSend<{ ok: boolean; created?: number }>(
    "POST",
    `/api/booking/staff/${input.staffId}/exceptions`,
    body,
  );
  if (res.ok) {
    revalidatePath("/dashboard/booking");
    return { ok: true, created: res.data?.created };
  }
  return {
    ok: false,
    error: res.error ?? "failed",
    ...(res.reason ? { reason: res.reason } : {}),
    ...(res.conflicts ? { conflicts: res.conflicts } : {}),
    ...(res.confirmation ? { confirmation: res.confirmation } : {}),
  };
}

/**
 * Un-block time: delete the one-off exception behind a hatched band.
 *
 * The block was always removable through the API, but nothing in the app ever
 * called it — a barber who blocked a day off had no way to give it back. The
 * id here is the AgendaRow id of a `source: "block"` row, which IS the
 * AvailabilityException id.
 *
 * Only NATIVE blocks. Acuity/Square blocks are ExternalBlock rows owned by the
 * upstream calendar; deleting one here would be undone by the next re-sync, so
 * the UI points the barber at Acuity instead of pretending.
 */
export async function removeBlockAction(exceptionId: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/exceptions/${exceptionId}`));
}

/**
 * Chair-side checkout: record what was collected and complete the cut.
 *
 * Returns the API's error string untouched so the caller can tell the double
 * -tap case apart — a 409 `paid_already` means the money DID land, and telling
 * the barber to "try again" would be exactly the wrong advice.
 */
export async function checkoutAppointmentAction(
  appointmentId: string,
  input: { amount: number; method: "cash" | "direct" | "card" | "other" },
): Promise<Result> {
  return done(
    await apiSend("POST", `/api/booking/appointments/${appointmentId}/checkout`, input),
  );
}

/** What a payment method can do for this cut, and why not when it cannot. */
export interface CheckoutMethodState {
  available: boolean;
  blocker?: string | null;
  /** The ONE amount this method may collect: the whole remaining balance. */
  dueCents?: number;
  card?: { brand: string | null; last4: string | null } | null;
}

export interface CheckoutAttemptView {
  id: string;
  state: string;
  method: string;
  amountCents: number;
  currency: string;
  card: { brand: string; last4: string } | null;
  failureReason: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface CheckoutState {
  appointment: {
    id: string;
    clientName: string | null;
    serviceName: string | null;
    startsAt: string;
    endsAt: string;
    status: string;
    paidAt: string | null;
    paidMethod: string | null;
  };
  totalCents: number | null;
  collectedCents: number;
  remainingCents: number | null;
  methods: {
    savedCard: CheckoutMethodState;
    tapToPay: CheckoutMethodState;
    cashOther: CheckoutMethodState;
  };
  liveAttempt: CheckoutAttemptView | null;
  // No `refunds` here on purpose, although the API still sends them: this read
  // refuses a cancelled appointment. The Refund panel uses
  // `getCheckoutRefundsAction`.
}

/** One checkout card payment, as the refund button needs it. */
export interface CheckoutRefundable {
  paymentId: string;
  method: "tap_to_pay" | "saved_card";
  collectedCents: number;
  refundedCents: number;
  /** What the button would give back. 0 when it cannot. */
  refundableCents: number;
  /** null only when the button would actually work. */
  refundBlocker: "refunded" | "unconfirmed_charge" | "partially_refunded" | null;
  card: { brand: string; last4: string } | null;
  paidAt: string;
}

export interface RefundResult {
  ok: boolean;
  /** What happened to the money. `unconfirmed` = pressing again is safe. */
  result?: "refunded" | "already_refunded" | "unconfirmed";
  amountCents?: number;
  status?: "succeeded" | "pending";
  error?: string;
  reason?: string;
  code?: string;
}

/**
 * Give a checkout card payment back, from ChairBack.
 *
 * 🔴 Not "refund it in Stripe". On a destination charge the barber's own
 * dashboard shows a copy of the payment, and refunding the copy takes the money
 * back from the barber while the customer gets nothing. This refunds the real
 * charge. See the API's billing/serviceRefund.ts.
 *
 * Mapped field by field rather than spread: the API seam drops unknown fields
 * from error bodies, and a 202 "unconfirmed" is HTTP-ok while the refund is not.
 */
export async function refundCheckoutPaymentAction(
  appointmentId: string,
  input: { paymentId: string; amountCents: number; note?: string },
): Promise<RefundResult> {
  const res = await apiSend<{
    result?: RefundResult["result"];
    amountCents?: number;
    status?: RefundResult["status"];
  }>("POST", `/api/checkout/appointments/${appointmentId}/refund`, input);
  if (!res.ok) {
    return { ok: false, error: res.error ?? "failed", reason: res.reason, code: res.code };
  }
  const body = res.data ?? {};
  if (body.result === "unconfirmed") {
    return { ok: false, result: "unconfirmed", error: "unconfirmed" };
  }
  revalidatePath("/dashboard/booking");
  return { ok: true, result: body.result, amountCents: body.amountCents, status: body.status };
}

/**
 * What the checkout screen may offer for this cut.
 *
 * 🔴 Read fresh every time the screen opens. The amount and the methods are the
 * SERVER's answer, never the agenda row's - a stale figure is how a barber
 * confirms one number while another is charged.
 */
export async function getCheckoutAction(
  appointmentId: string,
): Promise<{ ok: boolean; data?: CheckoutState; error?: string }> {
  const res = await apiGet<CheckoutState>(`/api/checkout/appointments/${appointmentId}`);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

/**
 * The card payments the Refund panel may offer back, for ANY appointment this
 * shop owns - cancelled included.
 *
 * 🔴 Not `getCheckoutAction`. That read refuses a cancelled appointment, since
 * there is nothing left to collect, and the panel used to borrow it. So
 * cancelling a paid appointment hid the only way to refund it, and cancelling
 * refunds nothing.
 */
export async function getCheckoutRefundsAction(
  appointmentId: string,
): Promise<{ ok: boolean; refunds?: CheckoutRefundable[]; error?: string }> {
  const res = await apiGet<{ refunds: CheckoutRefundable[] }>(
    `/api/checkout/appointments/${appointmentId}/refunds`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, refunds: res.data.refunds ?? [] };
}

export type ChargeCardResult = Result & {
  result?: "paid" | "requires_action" | "processing" | "ambiguous" | "declined" | "unavailable";
  amountCents?: number;
  card?: { brand: string | null; last4: string | null } | null;
  paidAt?: string | null;
  receiptReference?: string | null;
  replay?: boolean;
  attempt?: CheckoutAttemptView;
  message?: string;
  dueCents?: number;
};

/**
 * Charge the saved card. `requestId` identifies ONE press of the button: send
 * the same value again and the server replays the first answer instead of
 * charging twice, which is what makes a double tap and a lost response safe.
 */
export async function chargeSavedCardAction(
  appointmentId: string,
  input: { amountCents: number; requestId: string },
): Promise<ChargeCardResult> {
  const res = await apiSend(
    "POST",
    `/api/checkout/appointments/${appointmentId}/charge-card`,
    input,
  );
  const body = (res.data ?? {}) as Record<string, unknown>;
  return {
    ok: res.ok,
    error: res.ok ? undefined : ((body.error as string) ?? res.error ?? "failed"),
    ...(body as object),
  } as ChargeCardResult;
}

export type TapToPayIntentResult = Result & {
  attemptId?: string;
  clientSecret?: string;
  paymentIntentId?: string;
  connectAccountId?: string;
  amountCents?: number;
  replay?: boolean;
  attempt?: CheckoutAttemptView;
  dueCents?: number;
  liveAttempt?: CheckoutAttemptView;
};

/**
 * Open a contactless collection and get the secret the phone collects against.
 *
 * 🔴 NO MONEY MOVES HERE, and the attempt is open the moment this returns. The
 * card has not been presented yet, but from now until the collection is
 * concluded every other method is blocked - because a card that is about to be
 * tapped can still take the money after a barber gives up and takes cash.
 */
export async function startTapToPayAction(
  appointmentId: string,
  input: { amountCents: number; requestId: string },
): Promise<TapToPayIntentResult> {
  const res = await apiSend(
    "POST",
    `/api/checkout/appointments/${appointmentId}/tap-to-pay-intent`,
    input,
  );
  const body = (res.data ?? {}) as Record<string, unknown>;
  return {
    ok: res.ok,
    error: res.ok ? undefined : ((body.error as string) ?? res.error ?? "failed"),
    ...(body as object),
  } as TapToPayIntentResult;
}

/** The shop's Terminal Location + a connection token, which only a session can get. */
export async function terminalConnectionTokenAction(): Promise<{
  ok: boolean;
  secret?: string;
  locationId?: string;
  connectAccountId?: string;
  error?: string;
}> {
  const res = await apiSend("POST", `/api/payments/terminal/connection-token`, {});
  const body = (res.data ?? {}) as Record<string, unknown>;
  return {
    ok: res.ok,
    error: res.ok ? undefined : ((body.error as string) ?? res.error ?? "failed"),
    ...(body as object),
  };
}

/**
 * Ask the server what actually happened to a tap.
 *
 * 🔴 The phone's answer is a HINT. This is the only thing that decides whether
 * money arrived, because it reads Stripe rather than believing a device.
 */
export async function settleTapToPayAction(
  appointmentId: string,
  input: { attemptId: string },
): Promise<ChargeCardResult> {
  const res = await apiSend(
    "POST",
    `/api/checkout/appointments/${appointmentId}/tap-to-pay-settle`,
    input,
  );
  const body = (res.data ?? {}) as Record<string, unknown>;
  return {
    ok: res.ok,
    error: res.ok ? undefined : ((body.error as string) ?? res.error ?? "failed"),
    ...(body as object),
  } as ChargeCardResult;
}

/** Record money taken in person. Creates no Stripe charge of any kind. */
export async function recordCashCheckoutAction(
  appointmentId: string,
  input: {
    amountCents: number;
    method: "cash" | "direct" | "other";
    requestId: string;
    confirmed: true;
  },
): Promise<ChargeCardResult> {
  const res = await apiSend("POST", `/api/checkout/appointments/${appointmentId}/cash`, input);
  const body = (res.data ?? {}) as Record<string, unknown>;
  return {
    ok: res.ok,
    error: res.ok ? undefined : ((body.error as string) ?? res.error ?? "failed"),
    ...(body as object),
  } as ChargeCardResult;
}

/**
 * Conclude an attempt that is waiting on customer authentication, so another
 * method becomes available. The API refuses this for an `ambiguous` attempt -
 * that one may only be resolved by reading Stripe's own answer.
 */
export async function cancelCheckoutAttemptAction(
  appointmentId: string,
  attemptId: string,
): Promise<Result> {
  return done(
    await apiSend("POST", `/api/checkout/appointments/${appointmentId}/cancel-attempt`, {
      attemptId,
    }),
  );
}

/**
 * Correct a booking's price from the sheet. `collected` is accepted by the API
 * only once the booking has been checked out — before that, checkout owns the
 * chair figure. Dollars with at most two decimals; the API refuses more.
 */
export async function updateAppointmentPriceAction(
  appointmentId: string,
  input: { amount: number; collected?: number },
): Promise<Result> {
  return done(
    await apiSend("POST", `/api/booking/appointments/${appointmentId}/price`, input),
  );
}

//  Waitlist (phase E admin)

export type WaitlistSection =
  | "WAITING"
  | "CONTACTED"
  | "BOOKED"
  | "EXPIRED"
  | "REMOVED";
export type WaitlistSort = "joined" | "requested";

/** One preference window, exactly as stored (NULL dates = legacy). */
export interface WaitlistWindowView {
  startDate: string | null;
  endDate: string | null;
  startMin: number | null;
  endMin: number | null;
}

/** A waitlist entry as the admin board reads it. */
export interface WaitlistEntry {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  serviceId: string | null;
  staffId: string | null;
  serviceName: string | null;
  staffName: string | null;
  preferredTime: string | null;
  note: string | null;
  status: string;
  createdAt: string;
  windows: WaitlistWindowView[];
  timezone: string | null;
  minHoursNotice: number | null;
  notifiedAt: string | null;
  requestedDate: string | null;
  /** Joined before fixed 14-day windows - eligible with no end date. */
  legacyAnyDate: boolean;
  bookedAppointmentId: string | null;
  /** Null on a BOOKED entry means it was booked OUTSIDE ChairBack. */
  bookedAppointment: {
    id: string;
    startsAt: string;
    status: string;
    staffName: string | null;
    serviceName: string | null;
  } | null;
}

export interface WaitlistPage {
  ok: true;
  waitlist: WaitlistEntry[];
  counts: Record<WaitlistSection, number>;
  nextCursor: string | null;
}

/** One page of the board, filtered + sorted. Keyset - no offset, no cap. */
export async function getWaitlistAction(opts: {
  status?: WaitlistSection;
  staffId?: string;
  sort?: WaitlistSort;
  cursor?: string;
  limit?: number;
}): Promise<WaitlistPage | { ok: false; error: string }> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.staffId) q.set("staffId", opts.staffId);
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.limit) q.set("limit", String(opts.limit));
  const res = await apiGet<{
    waitlist: WaitlistEntry[];
    counts: Record<WaitlistSection, number>;
    nextCursor: string | null;
  }>(`/api/dashboard/waitlist?${q.toString()}`);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return {
    ok: true,
    waitlist: res.data.waitlist,
    counts: res.data.counts,
    nextCursor: res.data.nextCursor,
  };
}

/**
 * Staff-side create. No consent field exists on purpose - a barber cannot
 * consent to texts on a customer's behalf (see the API route).
 */
export async function createWaitlistEntryAction(input: {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  serviceId?: string;
  staffId?: string;
  note?: string;
  minHoursNotice?: number | null;
  windows?: { startDate: string | null; endDate: string | null; startMin: number | null; endMin: number | null }[];
}): Promise<Result> {
  return done(await apiSend("POST", "/api/dashboard/waitlist", input));
}

/**
 * Status only. BOOKED through THIS action means "booked outside ChairBack" and
 * deliberately leaves bookedAppointmentId null; booking inside the app links
 * atomically in the create transaction instead (see createAppointmentAction's
 * waitlistEntryId).
 */
export async function setWaitlistStatusAction(
  id: string,
  status: WaitlistSection,
): Promise<Result> {
  return done(await apiSend("POST", `/api/dashboard/waitlist/${id}`, { status }));
}

//  Appointments

export async function cancelAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/cancel`));
}

/**
 * Undo a cancel.
 *
 * Narrow by design (see the route): the server refuses anything already
 * refunded, already promoted to a Visit, outside the window, or whose slot has
 * since been taken. So this returns the REASON rather than a bare boolean - the
 * caller has to be able to say which of those happened, and "couldn't undo" is
 * a useless thing to tell a barber whose slot was just claimed.
 */
export async function restoreAppointmentAction(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("POST", `/api/booking/appointments/${id}/restore`);
  return { ok: res.ok, error: res.error };
}

/** Clear a cancelled / no-show row off the day view. Never a delete. */
export async function dismissAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/dismiss`));
}

export async function noShowAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/no-show`));
}

export async function completeAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/complete`));
}

/**
 * Record a nameless walk-in and what they paid, in one call. No client row, no
 * service pick, no availability check - see the route for why.
 *
 * `staffId` is omitted when the shop has one barber: the API resolves a solo
 * shop or the signed-in barber itself and only answers `staff_required` when it
 * genuinely cannot tell, so the UI asks only when it has to.
 */
export type WalkInResult =
  | { ok: true; conflict?: { withAppointmentIds: string[] } }
  | { ok: false; error: string };

export async function recordWalkInAction(input: {
  amount: number;
  staffId?: string;
  method?: "cash" | "direct" | "card" | "other";
  /**
   * Minted by the caller ONCE per submission and reused by every retry of it,
   * so a timeout or a double tap collapses to one receipt while two real cuts
   * seconds apart stay two.
   */
  operationId?: string;
  /**
   * When the cut happened (UTC ISO), for one written down after the fact.
   * Omitted means now - the ordinary walk-in. The server refuses the future.
   */
  occurredAt?: string;
}): Promise<WalkInResult> {
  const res = await apiSend<{
    ok: boolean;
    id: string;
    conflict?: { withAppointmentIds: string[] };
  }>("POST", "/api/booking/appointments/walk-in", input);
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  revalidatePath("/dashboard/booking");
  // 🔴 NOT `done()`. That helper throws the response BODY away and returns
  // only {ok}, which is exactly how a recorded-but-conflicting receipt reached
  // the barber as a plain success toast. The conflict has to survive the trip
  // or none of the server-side detection is worth anything.
  return res.data?.conflict
    ? { ok: true, conflict: res.data.conflict }
    : { ok: true };
}

/** Barber marks the client as physically arrived (check-in pill -> Arrived). */
export async function markArrivedAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/arrived`));
}

/**
 * Apply a ready reward to a client from the day view ("Reward ready - apply to
 * this visit?"). Reuses the client-page redeem endpoint; Skip is UI-only (the
 * reward stays ready).
 */
export async function applyRewardAction(
  clientId: string,
  rewardId: string,
): Promise<Result> {
  return done(
    await apiSend("POST", `/api/dashboard/redeem/${clientId}`, { rewardId }),
  );
}

//  Targeted slots (one-off special-priced bookable slots)

export interface TargetedSlotRow {
  id: string;
  staffId: string;
  serviceId: string;
  /** Every service this slot is bookable as. serviceId is the primary and is
   *  always a member; the API is authoritative via the join table. */
  serviceIds?: string[];
  label: string | null;
  startsAt: string;
  durationMin: number;
  price: number;
  active: boolean;
  // The weekly series this row was materialized from (null = one-off).
  ruleId: string | null;
  booked: boolean;
}

/** One time-of-day in a rule's weekly schedule (shop-local minutes).
 *  durationMin/price fall back to the rule's base when absent. */
export interface RuleScheduleTime {
  startMin: number;
  durationMin?: number;
  price?: number;
  /** Present = this entry is a WINDOW of repeating `slotMin`-minute slots
   *  packed inside `durationMin`; absent = one slot exactly that long. */
  slotMin?: number;
}

/** A weekly series ("every night 9pm", "Mon+Sat mornings"), condensed to one
 *  dashboard card. `schedule` keys are shop-local weekdays "0"(Sun).."6". */
export interface TargetedSlotRuleRow {
  id: string;
  staffId: string;
  /** Duplicated but never published: no slots, no public availability, and it
   *  goes live only when the barber saves it. */
  draft?: boolean;
  serviceId: string;
  /** Every service this slot is bookable as. serviceId is the primary and is
   *  always a member; the API is authoritative via the join table. */
  serviceIds?: string[];
  label: string | null;
  schedule: Record<string, RuleScheduleTime[]>;
  durationMin: number;
  price: number;
  // true = repeats until turned off; false = a finite "N more weeks" batch.
  indefinite: boolean;
}

/**
 * Duplicate a weekly series. The copy is a DRAFT: same configuration, new id,
 * zero materialized slots, invisible to the public page until published.
 */
export async function duplicateTargetedRuleAction(
  id: string,
): Promise<Result & { ruleId?: string }> {
  const r = await apiSend<{ ruleId: string }>(
    "POST",
    `/api/booking/targeted-slots/rules/${id}/duplicate`,
    {},
  );
  // The new id comes back so the caller can open the copy in edit mode - the
  // barber has to review and publish it, so landing them anywhere else would
  // strand a draft they cannot see the point of.
  return { ...done(r), ruleId: r.data?.ruleId };
}

/** Duplicate a one-off slot. The copy is INACTIVE and carries no booking. */
export async function duplicateTargetedSlotAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/targeted-slots/${id}/duplicate`, {}));
}

export async function listTargetedSlotsAction(): Promise<{
  ok: boolean;
  slots?: TargetedSlotRow[];
  rules?: TargetedSlotRuleRow[];
}> {
  const res = await apiGet<{
    targetedSlots: TargetedSlotRow[];
    rules: TargetedSlotRuleRow[];
  }>("/api/booking/targeted-slots");
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, slots: res.data.targetedSlots, rules: res.data.rules };
}

export async function createTargetedSlotAction(input: {
  staffId: string;
  serviceId: string;
  /** Every service this ONE slot is bookable as. Omitted => just serviceId. */
  serviceIds?: string[];
  label?: string;
  startsAt: string;
  durationMin: number;
  price: number;
  repeatWeeks?: number;
  repeatForever?: boolean;
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/targeted-slots", input));
}

/**
 * The schedule-shaped create: any weekdays x times per week in ONE rule
 * ("every night at 9pm", "mornings and afternoons daily"). Times are shop-tz
 * wall clock "HH:MM"; a per-time price/duration overrides the base.
 */
export async function createTargetedScheduleAction(input: {
  staffId: string;
  serviceId: string;
  serviceIds?: string[];
  label?: string;
  durationMin: number;
  price: number;
  schedule: Record<string, { start: string; durationMin?: number; price?: number; slotMin?: number }[]>;
  startDate?: string; // YYYY-MM-DD, shop-local; defaults to today
  repeatWeeks?: number;
  repeatForever?: boolean;
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/targeted-slots", input));
}

export async function deleteTargetedSlotAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/targeted-slots/${id}`));
}

/**
 * Edit a series in place: label/price/base duration/schedule. The server
 * regenerates the FUTURE UNBOOKED occurrences from the new values; booked and
 * past ones keep what the client claimed. Staff/service are deliberately not
 * editable - that's a different special (turn off + republish).
 */
export async function updateTargetedSlotRuleAction(
  id: string,
  input: {
    label?: string; // "" clears it
    durationMin?: number;
    price?: number;
    schedule?: Record<string, { start: string; durationMin?: number; price?: number; slotMin?: number }[]>;
  },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/targeted-slots/rules/${id}`, input));
}

/** Edit one UNBOOKED occurrence (move/reprice/relabel). Booked ones 409. */
export async function updateTargetedSlotAction(
  id: string,
  input: { startsAt?: string; durationMin?: number; price?: number; label?: string },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/targeted-slots/${id}`, input));
}

/** Turn a series off / remove a finite batch (future unbooked rows deleted). */
export async function deleteTargetedSlotRuleAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/targeted-slots/rules/${id}`));
}

/** Remove several hand-picked unbooked slots at once. */
export async function bulkDeleteTargetedSlotsAction(ids: string[]): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/targeted-slots/bulk-delete", { ids }));
}

/**
 * Push a "come early" nudge to the appointment's client. Max 2 per appointment
 * (server-enforced; surfaces as error "nudge_limit"). delivered:false = the
 * client has no registered push device.
 */
export async function nudgeAppointmentAction(
  id: string,
  body: string,
): Promise<Result & { delivered?: boolean }> {
  const res = await apiSend<{ ok: boolean; delivered?: boolean }>(
    "POST",
    `/api/booking/appointments/${id}/nudge`,
    { body },
  );
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, delivered: res.data?.delivered };
}

/* ------------------------------------------------------------------ */
/* Upgrade prompts                                                     */
/* ------------------------------------------------------------------ */

/** "Book any of sourceServiceIds, get offered destinationServiceId." */
export interface UpgradeRuleRow {
  id: string;
  sourceServiceIds: string[];
  destinationServiceId: string;
  active: boolean;
}

export async function listUpgradeRulesAction(): Promise<{
  ok: boolean;
  rules?: UpgradeRuleRow[];
}> {
  const res = await apiGet<{ rules: UpgradeRuleRow[] }>("/api/booking/upgrade-rules");
  return res.ok ? { ok: true, rules: res.data?.rules ?? [] } : { ok: false };
}

export async function createUpgradeRuleAction(input: {
  sourceServiceIds: string[];
  destinationServiceId: string;
}): Promise<Result> {
  // The API answers self_upgrade / cycle with a human message; surface it
  // rather than a generic failure, because the barber can act on it.
  const res = await apiSend<{ ruleId: string }>(
    "POST",
    "/api/booking/upgrade-rules",
    input,
  );
  return done(res);
}

export async function updateUpgradeRuleAction(
  id: string,
  input: { active?: boolean; sourceServiceIds?: string[]; destinationServiceId?: string },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/upgrade-rules/${id}`, input));
}

export async function deleteUpgradeRuleAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/upgrade-rules/${id}`));
}

//  Appointment detail (the sheet's own read)

/** The contact channels the sheet can act on. null = the action disappears. */
export interface DetailContact {
  /** E.164, ready for `tel:` / `sms:`. */
  phone: string | null;
  /** The same number formatted for a human to read. */
  phoneDisplay: string | null;
  email: string | null;
}

/**
 * MAY this shop TEXT this client - the same TCPA gate the nudge engine
 * enforces, surfaced so the sheet can disable Text with a true reason rather
 * than offer a tap that would either do nothing or break the rule.
 * `opted_out` and `no_consent` are genuinely different: only the CLIENT can
 * undo a STOP, while a missing opt-in is something the barber can go and ask
 * for.
 */
export interface DetailSms {
  state: "ok" | "no_phone" | "no_consent" | "opted_out" | "no_client";
  consentAt: string | null;
}

/** One line of the client's history. Deliberately carries no contact detail. */
export interface DetailHistoryItem {
  id: string;
  source: "appointment" | "visit";
  startsAt: string;
  serviceName: string | null;
  status: string;
  price: number | null;
}

/**
 * ONLY what ChairBack can verify about this booking's money. `external` means
 * another system took it (or didn't) and we refuse to guess - see the API's
 * engines/appointmentPayment.ts for the whole honesty rule.
 */
export interface DetailPayment {
  state: "external" | "unpaid" | "deposit" | "paid" | "refunded";
  totalCents: number | null;
  collectedCents: number;
  onlineCents: number;
  inPersonCents: number;
  refundedCents: number;
  /** An UNCAPTURED card hold: not collected, and it does not reduce the balance. */
  authorizedCents: number;
  /** A card kept at booking (card on file) and what became of it; null when none. Optional: a web deploy ahead of the API renders the plain label. */
  cardOnFile?: { status: string } | null;
  remainingCents: number | null;
  method: string | null;
  /** Always null - ChairBack persists no card data. Rendered only if it ever isn't. */
  card: { brand: string; last4: string } | null;
  receiptUrl: string | null;
}

export interface AppointmentDetail {
  id: string;
  source: "appointment" | "visit";
  /** WHERE it came from - a separate fact from its status. */
  origin: "chairback" | "external";
  originLabel: string;
  status: "pending" | "upcoming" | "completed" | "canceled" | "no_show";
  checkInStatus: "en_route" | "arrived" | null;
  clientId: string | null;
  clientName: string;
  serviceName: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string | null;
  durationMin: number | null;
  timezone: string;
  price: number | null;
  notes: string | null;
  addOns: { id: string; name: string }[];
  /**
   * What the customer answered to the shop's OWN booking questions - the
   * address a mobile mechanic is driving to, the vehicle he is quoting parts
   * for. Read from the booking's frozen snapshot, so it says what was answered
   * then even if the question has since been renamed or deleted.
   */
  intake: { label: string; value: string; kind: string }[];
  contact: DetailContact;
  /** Whether Text is a real action here, and why not when it isn't. */
  sms: DetailSms;
  /** The client's other bookings with this shop - 3 back, 3 forward. */
  history: { previous: DetailHistoryItem[]; upcoming: DetailHistoryItem[] };
  payment: DetailPayment;
  /**
   * When the barber closed the chair moment. Null = never checked out, which
   * is the ONLY state in which "Start checkout" is a real action - the endpoint
   * is idempotent and 409s a second attempt.
   */
  checkedOutAt: string | null;
  /**
   * Whether the post-service checkout surface exists for this deploy. False
   * keeps the ORIGINAL chair-checkout screen, so the kill switch takes the new
   * flow away without taking checkout away. Optional so an API that predates
   * the flag reads as "off" rather than crashing the sheet.
   */
  serviceCheckoutEnabled?: boolean;
  editable: boolean;
  readOnlyReason: "external" | "not_editable" | null;
  externalManageUrl: string | null;
}

/**
 * Load ONE booking in full for the appointment sheet.
 *
 * Deliberately its own round trip rather than fattening the agenda: contact
 * details are the most sensitive thing on a barber's calendar, and a month
 * view pulls up to 2000 rows. They travel only when a sheet is actually
 * opened, for the one booking that was opened.
 */
export async function getAppointmentDetailAction(
  id: string,
  source: "appointment" | "visit",
): Promise<{ ok: boolean; data?: AppointmentDetail; error?: string }> {
  const base = source === "visit" ? "visits" : "appointments";
  const res = await apiGet<AppointmentDetail>(
    `/api/booking/${base}/${encodeURIComponent(id)}/detail`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

//  Appointment editing

export interface EditContext {
  timezone: string;
  services: { id: string; name: string; durationMin: number }[];
  staff: { id: string; name: string }[];
  clients: { id: string; name: string; phone: string | null }[];
}

/**
 * Everything the edit sheet needs to prefill, in one round trip: the shop's
 * timezone (wall-clock edits are meaningless without it), the active service
 * and staff lists, and the client book for the explicit change-client search.
 */
export async function getEditContextAction(): Promise<{
  ok: boolean;
  data?: EditContext;
  error?: string;
}> {
  const res = await apiGet<EditContext>("/api/booking/appointments/edit-context");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

export interface EditResult {
  ok: boolean;
  error?: string;
  status?: string;
  /** Acuity mirror outcome: active | failed | unknown | skipped | observed. */
  mirror?: string;
  /**
   * For `external_block`: the block in words, in the SHOP's zone, exactly as
   * the server wrote it. The sheet shows this - it never rebuilds the sentence
   * from parts, and never renders it as markup.
   */
  reason?: string;
  /** For `external_block`: what to send back to confirm THAT block. */
  confirmation?: string;
}

/**
 * Save an appointment edit. Sends ONLY the changed fields, so an untouched
 * price or note is never rewritten. The mirror outcome comes straight back so
 * the sheet can be honest when Acuity did not confirm a move.
 */
export async function editAppointmentAction(
  id: string,
  patch: Record<string, unknown>,
): Promise<EditResult> {
  const res = await apiSend<{ status?: string; mirror?: string }>(
    "PATCH",
    `/api/booking/appointments/${encodeURIComponent(id)}`,
    patch,
  );
  if (res.ok) revalidatePath("/dashboard/booking");
  return {
    ok: res.ok,
    error: res.ok ? undefined : (res.error ?? "failed"),
    status: res.data?.status,
    mirror: res.data?.mirror,
    ...(res.reason ? { reason: res.reason } : {}),
    ...(res.confirmation ? { confirmation: res.confirmation } : {}),
  };
}

//  Walk-In Mode: the Live Queue board (PR 3)

export interface WalkInServiceView {
  serviceId: string;
  name: string;
  durationMin: number;
  price: number | null;
  sortOrder: number;
}

export interface WalkInEntryRow {
  id: string;
  status: string;
  source: string;
  position: number;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  clientId: string | null;
  note: string | null;
  preferredStaffId: string | null;
  assignedStaffId: string | null;
  appointmentId: string | null;
  quotedWaitMin: number | null;
  joinedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  services: WalkInServiceView[];
  totalDurationMin: number;
  estimate: {
    projectedStaffId: string | null;
    startsAt: string | null;
    waitMin: number | null;
  };
}

export interface WalkInQueueData {
  acceptingNow: boolean;
  now: string;
  entries: WalkInEntryRow[];
  done?: Omit<WalkInEntryRow, "estimate">[];
}

/** The live queue (plus today's finished entries for the Done section).
 *  409 walk_in_disabled is a NORMAL answer - the board renders the
 *  "turned off" state from it, so it is surfaced, not swallowed. */
export async function getWalkInQueueAction(): Promise<{
  ok: boolean;
  data?: WalkInQueueData;
  error?: string;
}> {
  const res = await apiGet<WalkInQueueData>("/api/walk-ins/queue?includeDone=1");
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

export type WalkInSimpleAction =
  | "ready"
  | "return"
  | "leave"
  | "no-show"
  | "cancel"
  | "complete";

export async function walkInTransitionAction(
  id: string,
  action: WalkInSimpleAction,
): Promise<Result> {
  const res = await apiSend("POST", `/api/walk-ins/${id}/${action}`);
  return done(res);
}

export async function walkInAssignAction(
  id: string,
  staffId: string,
): Promise<Result> {
  const res = await apiSend("POST", `/api/walk-ins/${id}/assign`, { staffId });
  return done(res);
}

export async function walkInStartAction(
  id: string,
  staffId?: string,
): Promise<Result> {
  const res = await apiSend(
    "POST",
    `/api/walk-ins/${id}/start`,
    staffId ? { staffId } : {},
  );
  return done(res);
}

export async function walkInReorderAction(
  id: string,
  afterEntryId: string | null,
  expectedPosition: number,
): Promise<Result> {
  const res = await apiSend("POST", `/api/walk-ins/${id}/reorder`, {
    afterEntryId,
    expectedPosition,
  });
  return done(res);
}

/** Walk-In Mode settings (manager-gated field-level on the API). */
export async function saveWalkInSettingsAction(input: {
  walkInEnabled?: boolean;
  walkInAcceptingNow?: boolean;
}): Promise<Result> {
  return done(await apiSend("PATCH", "/api/shops/me", input));
}

/**
 * Mint (or ROTATE) the kiosk URL. The raw credential appears exactly once -
 * in this response - because only its hash is stored; rotating kills every
 * tablet holding the old URL at once.
 */
export async function mintWalkInKioskUrlAction(): Promise<{
  ok: boolean;
  url?: string;
  error?: string;
}> {
  const res = await apiSend<{ ok: true; url: string }>(
    "POST",
    "/api/shops/me/walk-in-kiosk-token",
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, url: res.data.url };
}

// --- Openings held for a loyalty tier ---------------------------------------------

export type TierKey = "BRONZE" | "SILVER" | "GOLD";

export interface TierOpeningRow {
  id: string;
  staffName: string | null;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  minTier: TierKey;
  heldUntil: string;
  state: "held" | "claimed" | "released" | "open";
  recipients: number;
  claimedBy: string | null;
}

/** Who would hear about a hold for this tier - asked before anything is held. */
export async function previewTierOpeningAction(
  minTier: TierKey,
): Promise<{ ok: boolean; members?: number; inApp?: number }> {
  const res = await apiSend<{ members: number; inApp: number }>("POST", "/api/tier-openings/preview", { minTier });
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, members: res.data.members, inApp: res.data.inApp };
}

/** Hold a slot for a tier and tell its members. `error` is the API's code. */
export async function createTierOpeningAction(input: {
  staffId: string;
  serviceId: string;
  startsAt: string;
  minTier: TierKey;
  holdMinutes: number;
}): Promise<{ ok: boolean; heldUntil?: string; recipients?: number; error?: string }> {
  const res = await apiSend<{ heldUntil: string; recipients: number }>("POST", "/api/tier-openings", input);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  revalidatePath("/dashboard/booking");
  return { ok: true, heldUntil: res.data.heldUntil, recipients: res.data.recipients };
}

export async function listTierOpeningsAction(): Promise<{ ok: boolean; openings?: TierOpeningRow[] }> {
  const res = await apiGet<{ openings: TierOpeningRow[] }>("/api/tier-openings");
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, openings: res.data.openings };
}

/** End a hold early: the slot goes straight back on the booking page. */
export async function releaseTierOpeningAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/tier-openings/${encodeURIComponent(id)}/release`));
}
