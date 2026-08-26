import type { Metadata } from "next";
import type { BookingModeKey } from "@chairback/config/constants";
import { API_BASE, apiGet } from "@/lib/api";
import { DemoTour } from "@/components/tour/DemoTour";
import { BookingManager } from "./BookingManager";

export const metadata: Metadata = { title: "Booking" };

export interface BookingShop {
  /** Already on the wire from /api/shops/me (serializeShop) - the interface
   *  just never declared it. Printed on the QR card. */
  name: string;
  slug: string | null;
  bookingMode: BookingModeKey;
  bookingUrl: string | null;
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
  waitlistEnabled: boolean;
  slotOpenedTextsEnabled: boolean;
  requireBookingApproval: boolean;
  bookingGroupsFirst: boolean;
  pushReminder24hEnabled: boolean;
  pushReminder2hEnabled: boolean;
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
  // Per-service booking-card photo (https URL in the public bucket), or null.
  imageUrl: string | null;
  durationMin: number;
  price: number | null;
  // Per-weekday price overrides ({ "0": 55 } = Sunday $55). {} = base every day.
  priceOverrides: Record<string, number>;
  dateOverrides: Record<string, number>;
  // Per-weekday duration overrides ({ "5": 20 } = Friday 20 min). {} = base.
  durationOverrides: Record<string, number>;
  /**
   * Per-weekday cap on how many of this service may be booked in one
   * shop-local day: {"0": 3} = at most 3 on Sundays. A weekday absent is
   * UNLIMITED. Enforced server-side on the customer paths only.
   */
  dailyLimits: Record<string, number>;
  // Per-weekday available-hours restriction ({ "1": [{ s: 600, e: 840 }] } =
  // "Mondays only 10:00-14:00"). Weekday absent = unrestricted; [] = closed that
  // day. {} = no restriction on any day (the default).
  hoursWindows: Record<string, { s: number; e: number }[]>;
  // Time-of-day price/duration windows ([{s,e,price,durationMin}] in shop-local
  // minutes, e exclusive, every day) layered over the weekday overrides. [] =
  // none (the default for every existing service).
  timeOverrides: { s: number; e: number; price: number | null; durationMin: number | null }[];
  // Calendar color-coding: a SERVICE_COLORS key, or null for no color.
  color: string | null;
  // True = offered by every active barber, kept in sync as staff change (staffIds
  // still lists the current concrete set). False = the hand-picked staffIds.
  offeredByAll: boolean;
  active: boolean;
  sortOrder: number;
  // Display-only daily slot target driving the calendar day gauge ("Fades 6/8").
  // NOT a cap - the slot engine never reads it, so a 7th booking just reads 7/6.
  // Only consulted while ungrouped; a grouped service uses its group's target.
  dailyTarget: number | null;
  staffIds: string[];
  // Non-null = this service belongs to a group; the group's hoursWindows + booking
  // limits override this service's own. null = ungrouped (the default for every
  // existing service, so zero behavior change).
  serviceGroupId: string | null;
}
/**
 * A group bundles several services under ONE shared set of BOOKING LIMITS
 * (maxPerDay = total bookings/shop-local-day across all members; maxConcurrent =
 * overlapping bookings at once across the group; either null = no cap).
 * serviceIds = current membership. A group does NOT carry hours - those belong to
 * the service and are edited in Services -> Edit.
 */
export interface ServiceGroupRow {
  id: string;
  name: string;
  maxPerDay: number | null;
  maxConcurrent: number | null;
  // Display-only daily slot target for the calendar day gauge, counted across
  // all member services. NOT a cap - see maxPerDay for the enforced ceiling.
  dailyTarget: number | null;
  active: boolean;
  sortOrder: number;
  serviceIds: string[];
}
export interface AddOnRow {
  id: string;
  name: string;
  durationMin: number;
  price: number | null;
  // [] = offered on every service; non-empty = only with those services.
  serviceIds: string[];
  active: boolean;
  sortOrder: number;
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
  /**
   * A synced Acuity/Square booking shown on a NATIVE shop's calendar (a shop
   * mid-transition). Read-only like any visit row, but badged so the barber
   * knows where it came from — and why that time is blocked for native booking.
   */
  syncedExternal?: boolean;
  start: string; // ISO
  end: string | null; // ISO
  clientName: string; // for a block: the reason (or "Blocked")
  serviceName: string | null;
  // Ids the edit sheet prefills from. Absent on visit/block rows, which are
  // never editable here.
  serviceId?: string | null;
  staffId?: string | null;
  /** Barber's private note on THIS booking (never the client's profile note). */
  notes?: string | null;
  serviceColor: string | null; // SERVICE_COLORS key for the calendar accent
  price: number | null;
  status: "pending" | "upcoming" | "completed" | "canceled" | "no_show" | "blocked";
  // Non-null = part of a recurring series (drives the ↻ badge + cancel-scope menu).
  seriesId?: string | null;
  // Check-in sub-state of an upcoming native appointment (live pill:
  // Booked -> En route -> Arrived). null/absent on visit + block rows.
  checkInStatus?: "en_route" | "arrived" | null;
  etaMinutes?: number | null;
  runningLate?: boolean;
  // Nudge affordance: false = client has no push device ("Notifications off");
  // nudgesSent/nudgeLimit drive the remaining-nudges state (max 2, server-enforced).
  hasPush?: boolean;
  nudgesSent?: number;
  nudgeLimit?: number;
  // For the Apply-reward action (redeem is client-keyed).
  clientId?: string | null;
  // Cheapest reward the row's client can afford right now (rewards shops only).
  // Drives "Reward ready - apply to this visit?" Apply/Skip on the row.
  rewardReady?: { rewardId: string; rewardName: string; punchCost: number } | null;
  // Which AgendaCategory this row counts toward on the day gauge. null =
  // uncategorized (a block, or a synced visit whose service name matched
  // nothing); those still count in the "All" total.
  categoryId?: string | null;
  // Add-ons chosen at booking. Names only — their price is already folded into
  // `price`, so the checkout itemises them without ever re-adding them.
  addOns?: { id: string; name: string }[];
  // Chair-side checkout. `paid` = dollars collected in person (null = not
  // checked out yet), `prepaid` = dollars Stripe already holds. They never
  // overlap, so what the chair still owes is price - prepaid - (paid ?? 0).
  paid?: number | null;
  paidMethod?: string | null;
  prepaid?: number;
}

/**
 * One bucket of the calendar day gauge: an active service group, or an active
 * UNGROUPED service. `target` is the barber's display-only daily slot target -
 * null means this bucket shows a plain count instead of a fraction.
 */
export interface AgendaCategory {
  id: string;
  name: string;
  target: number | null;
}

export interface AgendaResponse {
  agenda: AgendaRow[];
  source: "appointment" | "visit";
  timezone: string;
  // Absent on a cached/older payload - the calendar treats that as "no
  // categories", falling back to the plain appointment count.
  categories?: AgendaCategory[];
  /**
   * The window this payload covers (ISO instants), as the API resolved it.
   * Optional because an older cached payload predates it: without a window the
   * calendar merges additively and never retracts, which is exactly how it
   * behaved before - stale, but never wrongly blank.
   */
  from?: string;
  to?: string;
  /**
   * The answer hit a server row cap, so a row's absence proves nothing. The
   * calendar merges additively when this is set rather than retracting rows it
   * would otherwise conclude were cancelled.
   */
  truncated?: boolean;
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

export default async function BookingPage({
  searchParams,
}: {
  // `?tab=Appointments` lets the dashboard's "Book appointment" CTA land on the
  // calendar instead of the default Settings tab. An unknown or absent value
  // falls back to the default, so a stale or hand-typed link can't render blank.
  searchParams?: { tab?: string };
}) {
  // The month calendar loads the current month on first paint (with a week of
  // padding on each side so the visible grid's leading/trailing days are filled),
  // then fetches other months on demand via getAgendaAction as the barber pages.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const agendaFrom = new Date(monthStart.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const agendaTo = new Date(monthEnd.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [shopRes, staffRes, servicesRes, groupsRes, addOnsRes, agendaRes, waitlistRes, acuityRes, squareRes] =
    await Promise.all([
      apiGet<BookingShop>("/api/shops/me"),
      apiGet<{ staff: StaffRow[] }>("/api/booking/staff"),
      apiGet<{ services: ServiceRow[] }>("/api/booking/services"),
      apiGet<{ groups: ServiceGroupRow[] }>("/api/booking/groups"),
      apiGet<{ addOns: AddOnRow[] }>("/api/booking/addons"),
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
      {/* Barber-side guided tour — anchors live inside BookingManager. */}
      <DemoTour tour="dashboard" route="agenda" />
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
        initialTab={searchParams?.tab}
        appBase={process.env.APP_BASE_URL ?? ""}
        apiBase={API_BASE}
        connect={connect}
        initialStaff={staffRes.data?.staff ?? []}
        initialServices={servicesRes.data?.services ?? []}
        initialServiceGroups={groupsRes.data?.groups ?? []}
        initialAddOns={addOnsRes.data?.addOns ?? []}
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
