"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";

type Result = { ok: boolean; error?: string };

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

/** Disconnect the Google Calendar bridge: revokes + deletes the token. Visits kept. */
export async function disconnectGcalAction(): Promise<Result> {
  return done(await apiSend("POST", "/api/gcal/oauth/disconnect"));
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
