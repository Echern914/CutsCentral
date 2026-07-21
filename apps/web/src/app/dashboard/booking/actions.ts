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

export interface AvailabilityData {
  rules: { id: string; weekday: number; startMin: number; endMin: number }[];
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

export async function createServiceAction(input: {
  name: string;
  description?: string;
  durationMin: number;
  durationOverrides?: Record<string, number>;
  hoursWindows?: ServiceHoursWindows;
  price?: number | null;
  priceOverrides?: Record<string, number>;
  color?: string | null;
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
    durationMin?: number;
    durationOverrides?: Record<string, number>;
    hoursWindows?: ServiceHoursWindows;
    price?: number | null;
    priceOverrides?: Record<string, number>;
    active?: boolean;
    color?: string | null;
  offeredByAll?: boolean;
    staffIds?: string[];
  },
): Promise<Result> {
  return done(await apiSend("PATCH", `/api/booking/services/${id}`, input));
}

export async function deleteServiceAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/services/${id}`));
}

//  Availability

export async function saveAvailabilityAction(
  staffId: string,
  rules: { weekday: number; startMin: number; endMin: number }[],
): Promise<Result> {
  return done(
    await apiSend("PUT", `/api/booking/staff/${staffId}/availability`, { rules }),
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
  firstName: string | null;
  lastName: string | null;
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
  serviceId?: string | null;
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

//  Waitlist

export async function setWaitlistStatusAction(
  id: string,
  status: "WAITING" | "CONTACTED" | "BOOKED" | "REMOVED",
): Promise<Result> {
  return done(await apiSend("POST", `/api/dashboard/waitlist/${id}`, { status }));
}

//  Appointments

export async function cancelAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/cancel`));
}

export async function noShowAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/no-show`));
}

export async function completeAppointmentAction(id: string): Promise<Result> {
  return done(await apiSend("POST", `/api/booking/appointments/${id}/complete`));
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
  label: string | null;
  startsAt: string;
  durationMin: number;
  price: number;
  active: boolean;
  booked: boolean;
}

export async function listTargetedSlotsAction(): Promise<{
  ok: boolean;
  slots?: TargetedSlotRow[];
}> {
  const res = await apiGet<{ targetedSlots: TargetedSlotRow[] }>(
    "/api/booking/targeted-slots",
  );
  if (!res.ok || !res.data) return { ok: false };
  return { ok: true, slots: res.data.targetedSlots };
}

export async function createTargetedSlotAction(input: {
  staffId: string;
  serviceId: string;
  label?: string;
  startsAt: string;
  durationMin: number;
  price: number;
  repeatWeeks?: number;
}): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/targeted-slots", input));
}

export async function deleteTargetedSlotAction(id: string): Promise<Result> {
  return done(await apiSend("DELETE", `/api/booking/targeted-slots/${id}`));
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
