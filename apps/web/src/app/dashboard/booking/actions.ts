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
  /** null = fine. "unmapped" | "stale" | "invalid". */
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

//  New Appointment (barber-side) + Block Off Time (native booking)

export interface DashSlot {
  startsAt: string;
  endsAt: string;
}

/** Open slots for a (staff, service) over a range - powers the Time picker. */
export async function getDashSlotsAction(
  staffId: string,
  serviceId: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; slots?: DashSlot[]; timezone?: string; error?: string }> {
  const qs = new URLSearchParams({ staffId, serviceId, from, to }).toString();
  const res = await apiGet<{ timezone: string; slots: DashSlot[] }>(
    `/api/booking/slots?${qs}`,
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, slots: res.data.slots, timezone: res.data.timezone };
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
   * Booking someone off the waitlist: the entry flips to BOOKED and takes
   * bookedAppointmentId INSIDE the same transaction that creates the
   * appointment, so a half-linked state cannot exist.
   */
  waitlistEntryId?: string;
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

export type CreateApptResult = Result & { series?: SeriesSummary };

export async function createAppointmentAction(
  input: CreateApptInput,
): Promise<CreateApptResult> {
  const res = await apiSend<{ series?: SeriesSummary }>(
    "POST",
    "/api/booking/appointments",
    input,
  );
  if (res.ok) revalidatePath("/dashboard/booking");
  if (!res.ok) return { ok: false, error: res.error ?? "failed" };
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

export interface BlockOffInput {
  staffId: string;
  startsAt: string; // ISO
  endsAt: string; // ISO
  reason?: string;
}

/** Block off time (native). Reuses the existing staff-exceptions endpoint. */
export async function addBlockAction(input: BlockOffInput): Promise<Result> {
  return done(
    await apiSend("POST", `/api/booking/staff/${input.staffId}/exceptions`, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      isBlock: true,
      reason: input.reason,
    }),
  );
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
export async function recordWalkInAction(input: {
  amount: number;
  staffId?: string;
  method?: "cash" | "direct" | "card" | "other";
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/appointments/walk-in", input));
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
  schedule: Record<string, { start: string; durationMin?: number; price?: number }[]>;
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
    schedule?: Record<string, { start: string; durationMin?: number; price?: number }[]>;
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
  };
}
