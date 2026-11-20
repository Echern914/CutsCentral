"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiSend } from "@/lib/api";
import type { BarberRow } from "./BarberHome";

/**
 * A team member's own calendar: any day, their own hours, their own time off,
 * and booking, moving or cancelling their own clients.
 *
 * WHOSE calendar is decided by the API from the signed-in seat. Nothing here
 * sends a staff id, and the API refuses a request that tries to carry one, so
 * these actions cannot be pointed at a colleague.
 */
const BASE = "/api/barber/calendar";

export interface OwnDayRow extends BarberRow {
  /** Still to come and still booked: it can be moved or cancelled from here. */
  canChange: boolean;
}

export interface OwnBlock {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  /** Set by the shop for several people at once: shown, never removed from here. */
  shared: boolean;
}

export interface OwnDay {
  chair: { id: string; name: string } | null;
  shop: { name: string; timezone: string };
  /** The day shown, "YYYY-MM-DD" in the shop's zone. */
  date: string;
  /** The shop's own today, same format. */
  today: string;
  /** False while the shop books through a synced calendar. */
  canBook: boolean;
  rows: OwnDayRow[];
  blocks: OwnBlock[];
}

export interface OwnHours {
  rules: { id: string; weekday: number; startMin: number; endMin: number }[];
  recurringBlocks: {
    id: string;
    weekday: number;
    startMin: number;
    endMin: number;
    reason: string | null;
  }[];
  exceptions: {
    id: string;
    startsAt: string;
    endsAt: string;
    isBlock: boolean;
    reason: string | null;
    shared: boolean;
  }[];
  weekdaysWithNoService?: number[];
  timezone: string;
}

export interface OwnService {
  id: string;
  name: string;
  durationMin: number;
  price: number | null;
}

export interface OwnSlot {
  startsAt: string;
  endsAt: string;
}

type Read<T> = { ok: boolean; data?: T; error?: string };
type Wrote = { ok: boolean; error?: string };

async function read<T>(path: string): Promise<Read<T>> {
  const res = await apiGet<T>(`${BASE}${path}`);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "failed" };
  return { ok: true, data: res.data };
}

/** The home screen's counts and the day list both move when a booking does. */
function wrote(res: { ok: boolean; error?: string }): Wrote {
  if (res.ok) revalidatePath("/dashboard");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "failed" };
}

export async function getOwnDayAction(date?: string): Promise<Read<OwnDay>> {
  return read<OwnDay>(date ? `/day?date=${encodeURIComponent(date)}` : "/day");
}

export async function getOwnHoursAction(): Promise<Read<OwnHours>> {
  return read<OwnHours>("/hours");
}

export async function saveOwnHoursAction(
  rules: { weekday: number; startMin: number; endMin: number }[],
  recurringBlocks: { weekday: number; startMin: number; endMin: number; reason?: string }[] = [],
): Promise<Wrote> {
  return wrote(await apiSend("PUT", `${BASE}/hours`, { rules, recurringBlocks }));
}

export interface TimeOffInput {
  fromDate: string;
  toDate: string;
  /** Both, or neither for all day. Minutes from midnight in the shop's zone. */
  fromMin?: number;
  toMin?: number;
  reason?: string;
  /** Minted once per Save and re-sent on a retry, so a retry never doubles it. */
  requestId: string;
  /** Handed back by a refusal that listed bookings in the way. */
  confirmation?: string;
}

export async function addOwnTimeOffAction(input: TimeOffInput): Promise<
  Wrote & {
    /** Bookings in the way, one line each, already worded by the API. */
    conflicts?: string[];
    confirmation?: string;
  }
> {
  const window =
    input.fromMin !== undefined && input.toMin !== undefined
      ? { fromMin: input.fromMin, toMin: input.toMin }
      : {};
  const when =
    input.fromDate === input.toDate
      ? { kind: "day" as const, date: input.fromDate, ...window }
      : { kind: "daily" as const, fromDate: input.fromDate, toDate: input.toDate, ...window };
  const res = await apiSend("POST", `${BASE}/time-off`, {
    when,
    ...(input.reason ? { reason: input.reason } : {}),
    requestId: input.requestId,
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
  });
  if (res.ok) return wrote(res);
  return {
    ok: false,
    error: res.error ?? "failed",
    ...(res.conflicts ? { conflicts: res.conflicts } : {}),
    ...(res.confirmation ? { confirmation: res.confirmation } : {}),
  };
}

export async function removeOwnTimeOffAction(id: string): Promise<Wrote> {
  return wrote(await apiSend("DELETE", `${BASE}/time-off/${encodeURIComponent(id)}`));
}

export async function getOwnServicesAction(): Promise<Read<{ services: OwnService[] }>> {
  return read<{ services: OwnService[] }>("/services");
}

/** Open times on their own calendar: for a new booking of a service, or for moving a booking. */
export async function getOwnSlotsAction(
  input: { date: string } & ({ serviceId: string } | { appointmentId: string }),
): Promise<Read<{ timezone: string; slots: OwnSlot[] }>> {
  const what =
    "serviceId" in input
      ? `serviceId=${encodeURIComponent(input.serviceId)}`
      : `appointmentId=${encodeURIComponent(input.appointmentId)}`;
  return read<{ timezone: string; slots: OwnSlot[] }>(
    `/slots?date=${encodeURIComponent(input.date)}&${what}`,
  );
}

export interface BookOwnInput {
  serviceId: string;
  startsAt: string;
  /** One of their own clients... */
  clientId?: string;
  /** ...or somebody new. */
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  /** Minted once per submission and re-sent on a retry: one booking. */
  operationId: string;
}

export async function bookOwnAction(input: BookOwnInput): Promise<Wrote> {
  return wrote(await apiSend("POST", `${BASE}/appointments`, input));
}

export async function moveOwnAction(
  id: string,
  startsAt: string,
  acceptPriceCents?: number,
): Promise<Wrote & { fromCents?: number; toCents?: number }> {
  const res = await apiSend("POST", `${BASE}/appointments/${encodeURIComponent(id)}/move`, {
    startsAt,
    ...(acceptPriceCents !== undefined ? { acceptPriceCents } : {}),
  });
  if (res.ok) return wrote(res);
  // A different price at the new time: both figures, so the form can show them
  // and ask before the move is made.
  const body = (res.body ?? {}) as { fromCents?: unknown; toCents?: unknown };
  const fromCents = typeof body.fromCents === "number" ? body.fromCents : undefined;
  const toCents = typeof body.toCents === "number" ? body.toCents : undefined;
  return {
    ok: false,
    error: res.error ?? "failed",
    ...(fromCents !== undefined && toCents !== undefined ? { fromCents, toCents } : {}),
  };
}

export async function cancelOwnAction(id: string): Promise<Wrote> {
  return wrote(await apiSend("POST", `${BASE}/appointments/${encodeURIComponent(id)}/cancel`, {}));
}
