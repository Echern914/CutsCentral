"use server";

import { revalidatePath } from "next/cache";
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
  bookingMode: "link" | "acuity" | "native" | "square";
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
  slotOpenedTextsEnabled?: boolean;
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

export async function createServiceAction(input: {
  name: string;
  description?: string;
  durationMin: number;
  price?: number | null;
  priceOverrides?: Record<string, number>;
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
    price?: number | null;
    priceOverrides?: Record<string, number>;
    active?: boolean;
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
}

export async function createAppointmentAction(
  input: CreateApptInput,
): Promise<Result> {
  return done(await apiSend("POST", "/api/booking/appointments", input));
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
