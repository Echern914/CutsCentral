import type { Metadata } from "next";
import { API_BASE, apiGet } from "@/lib/api";
import { BookingManager } from "./BookingManager";

export const metadata: Metadata = { title: "Booking" };

export interface BookingShop {
  slug: string | null;
  bookingMode: "link" | "acuity" | "native" | "square";
  bookingUrl: string | null;
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
}

/** Live connect status for the branded platform cards. */
export interface ConnectStatus {
  acuityConnected: boolean;
  acuityAvailable: boolean;
  squareConnected: boolean;
  squareAvailable: boolean;
}
export interface StaffRow {
  id: string;
  name: string;
  bio: string | null;
  imageUrl: string | null;
  active: boolean;
  sortOrder: number;
}
export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  price: number | null;
  // Per-weekday price overrides ({ "0": 55 } = Sunday $55). {} = base every day.
  priceOverrides: Record<string, number>;
  active: boolean;
  sortOrder: number;
  staffIds: string[];
}
/**
 * One row of the barber's day-agenda calendar. Normalized on the server from
 * EITHER a native `Appointment` or a synced `Visit` (see /api/booking/agenda), so
 * the calendar renders identically regardless of how the shop takes bookings.
 * `source` gates the row actions: only native ("appointment") rows can be
 * marked done / no-show / canceled here; synced ("visit") rows are read-only.
 */
export interface AgendaRow {
  id: string;
  source: "appointment" | "visit" | "block";
  start: string; // ISO
  end: string | null; // ISO
  clientName: string; // for a block: the reason (or "Blocked")
  serviceName: string | null;
  price: number | null;
  status: "upcoming" | "completed" | "canceled" | "no_show" | "blocked";
}

export interface AgendaResponse {
  agenda: AgendaRow[];
  source: "appointment" | "visit";
  timezone: string;
}

/** One person waiting for a spot (barber-facing). */
export interface WaitlistRow {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  serviceName: string | null;
  staffName: string | null;
  preferredTime: string | null;
  note: string | null;
  status: "WAITING" | "CONTACTED" | "BOOKED" | "REMOVED";
  createdAt: string;
}

export default async function BookingPage() {
  // The month calendar loads the current month on first paint (with a week of
  // padding on each side so the visible grid's leading/trailing days are filled),
  // then fetches other months on demand via getAgendaAction as the barber pages.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const agendaFrom = new Date(monthStart.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const agendaTo = new Date(monthEnd.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [shopRes, staffRes, servicesRes, agendaRes, waitlistRes, acuityRes, squareRes] =
    await Promise.all([
      apiGet<BookingShop>("/api/shops/me"),
      apiGet<{ staff: StaffRow[] }>("/api/booking/staff"),
      apiGet<{ services: ServiceRow[] }>("/api/booking/services"),
      apiGet<AgendaResponse>(
        `/api/booking/agenda?from=${encodeURIComponent(agendaFrom)}&to=${encodeURIComponent(agendaTo)}`,
      ),
      apiGet<{ waitlist: WaitlistRow[]; waitingCount: number }>("/api/dashboard/waitlist"),
      // Connect status for the branded cards. These can 404/503 when a platform
      // isn't configured; treat any non-ok as "not connected / unavailable".
      apiGet<{ connected: boolean }>("/api/acuity/oauth/status"),
      apiGet<{ connected: boolean; available: boolean }>("/api/square/oauth/status"),
    ]);

  if (!shopRes.ok || !shopRes.data) {
    return <main className="p-8 text-muted">Could not load your booking setup.</main>;
  }

  const connect: ConnectStatus = {
    acuityConnected: Boolean(acuityRes.data?.connected),
    // Acuity has no "available" flag (it's always configured); treat reachable as available.
    acuityAvailable: acuityRes.ok,
    squareConnected: Boolean(squareRes.data?.connected),
    squareAvailable: Boolean(squareRes.data?.available),
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Booking</h1>
        <p className="mt-1 text-sm text-muted">
          Run your own online booking: add your staff, services, and hours, then
          flip booking on. Customers book real times at your page and earn loyalty
          automatically.
        </p>
      </header>
      <BookingManager
        shop={shopRes.data}
        appBase={process.env.APP_BASE_URL ?? ""}
        apiBase={API_BASE}
        connect={connect}
        initialStaff={staffRes.data?.staff ?? []}
        initialServices={servicesRes.data?.services ?? []}
        initialAgenda={
          agendaRes.data ?? {
            agenda: [],
            source: shopRes.data.bookingMode === "native" ? "appointment" : "visit",
            timezone: "America/New_York",
          }
        }
        initialWaitlist={waitlistRes.data?.waitlist ?? []}
      />
    </main>
  );
}
