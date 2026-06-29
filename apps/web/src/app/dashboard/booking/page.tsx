import type { Metadata } from "next";
import { API_BASE, apiGet } from "@/lib/api";
import { BookingManager } from "./BookingManager";

export const metadata: Metadata = { title: "Booking" };

export interface BookingShop {
  slug: string | null;
  bookingMode: "link" | "acuity" | "native" | "square";
  bookingUrl: string;
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
export interface AppointmentRow {
  id: string;
  status: "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  startsAt: string;
  endsAt: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  staff: { id: string; name: string };
  service: { id: string; name: string };
}

export default async function BookingPage() {
  const [shopRes, staffRes, servicesRes, apptsRes, acuityRes, squareRes] = await Promise.all([
    apiGet<BookingShop>("/api/shops/me"),
    apiGet<{ staff: StaffRow[] }>("/api/booking/staff"),
    apiGet<{ services: ServiceRow[] }>("/api/booking/services"),
    apiGet<{ appointments: AppointmentRow[] }>(
      `/api/booking/appointments?from=${encodeURIComponent(new Date().toISOString())}`,
    ),
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
          Run your own online booking: add your barbers, services, and hours, then
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
        initialAppointments={apptsRes.data?.appointments ?? []}
      />
    </main>
  );
}
