import type { Router } from "express";
import parsePhoneNumberFromString from "libphonenumber-js";
import { forShop, prisma, type Prisma } from "@chairback/db";
import {
  appointmentPaymentSnapshot,
  type AppointmentPaymentSnapshot,
} from "../engines/appointmentPayment.js";
import { appointmentOwnedByPlatform } from "../engines/visitOrigin.js";

/**
 * ONE BOOKING, IN FULL — the read behind the appointment sheet.
 *
 * The day agenda deliberately does NOT carry any of this. Phone numbers and
 * email addresses are the most sensitive thing a barber's calendar holds, and
 * a month view fetches up to 2000 rows at a time; shipping contact details for
 * a whole month so that a barber MIGHT tap one card would put every client's
 * number into a payload nobody asked for. This endpoint is the narrow door:
 * one id, one row, contact resolved only when the sheet is actually opened.
 *
 * Two shapes, because a shop can have both kinds of booking on one calendar:
 *
 *   GET /appointments/:id/detail — a NATIVE ChairBack booking. Editable, and
 *     ChairBack owns the money, so the payment snapshot is real.
 *   GET /visits/:id/detail — a booking SYNCED from Acuity/Square. Read-only
 *     here (the other system owns the schedule) and its payment state is
 *     `external`: we can show the contact we synced and refuse to guess at
 *     money we never saw.
 *
 * 🔴 SHOP SCOPING IS THE WHOLE SECURITY MODEL of this file. Every read goes
 * through `forShop(shopId)` with an explicit `shopId` in the WHERE, so an id
 * belonging to another tenant is simply NOT FOUND — never an authorization
 * error that would confirm the row exists.
 *
 * 🔴 NOTHING HERE IS LOGGED. Not the phone, not the email, not the name. The
 * edit endpoint logs field NAMES for audit and this one logs nothing at all,
 * because there is no operational question a contact-detail read answers.
 */

/** The contact channels the sheet can act on. Absent = the action disappears. */
interface DetailContact {
  /** E.164, ready for `tel:` / `sms:`. Null when nothing usable is on file. */
  phone: string | null;
  /** The same number formatted for a human to read; null when phone is null. */
  phoneDisplay: string | null;
  email: string | null;
}

/**
 * MAY THIS SHOP TEXT THIS CLIENT — and if not, why not.
 *
 * The same two gates the nudge engine enforces (`engines/eligibility.ts` R5-R7),
 * surfaced so the sheet can DISABLE its Text action with a true reason instead
 * of offering a tap that would either do nothing or break TCPA. The two "no"s
 * are genuinely different and the barber's next move differs:
 *
 *   opted_out  — they consented once and then texted STOP. Only the CLIENT can
 *                undo that (START, or their rewards page); the dashboard may
 *                not, so the sheet must not imply the barber can fix it.
 *   no_consent — nobody ever captured an opt-in (every Acuity-synced client
 *                starts here). That IS fixable, by asking them.
 *
 * `tel:` is unaffected — consent governs SMS, not a phone call.
 */
export type SmsReach = "ok" | "no_phone" | "no_consent" | "opted_out" | "no_client";

interface DetailSms {
  state: SmsReach;
  /** When the opt-in was captured. Null unless `state === "ok"`. */
  consentAt: string | null;
}

/** One line of the client's history with this shop. Never carries contact. */
export interface DetailHistoryItem {
  id: string;
  source: "appointment" | "visit";
  startsAt: string;
  serviceName: string | null;
  /** Same vocabulary as the sheet's own status: upcoming | completed | … */
  status: string;
  price: number | null;
}

export function smsReach(client: {
  phone: string | null;
  optedOut: boolean;
  smsConsentAt: Date | null;
} | null): DetailSms {
  // A walk-in with no client row has no consent record to consult — and no
  // number of ours to text either.
  if (!client) return { state: "no_client", consentAt: null };
  if (!client.phone) return { state: "no_phone", consentAt: null };
  // optedOut is checked BEFORE consent: a client who consented and then texted
  // STOP is opted out, and that is the more specific (and less fixable) truth.
  if (client.optedOut) return { state: "opted_out", consentAt: null };
  if (client.smsConsentAt === null) return { state: "no_consent", consentAt: null };
  return { state: "ok", consentAt: client.smsConsentAt.toISOString() };
}

export interface AppointmentDetail {
  id: string;
  source: "appointment" | "visit";
  /**
   * WHERE THE BOOKING CAME FROM — a separate fact from its status. A synced
   * booking is just as booked as a native one; what differs is who owns it.
   */
  origin: "chairback" | "external";
  /** "ChairBack" | "Acuity" | "Square" | "your booking platform". */
  originLabel: string;
  /** pending | upcoming | completed | canceled | no_show. */
  status: string;
  /** null | "en_route" | "arrived" — refines "upcoming" into the live pill. */
  checkInStatus: string | null;
  clientId: string | null;
  clientName: string;
  serviceName: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string | null;
  durationMin: number | null;
  /** The SHOP's timezone — the only one an appointment time means anything in. */
  timezone: string;
  price: number | null;
  /** The barber's private note on THIS booking (never the client's profile note). */
  notes: string | null;
  addOns: { id: string; name: string }[];
  contact: DetailContact;
  /** Whether Text is a real action here, and why not when it isn't. */
  sms: DetailSms;
  /**
   * The rest of this client's book with this shop — the 3 most recent past
   * bookings and the 3 next ones, excluding this one. A barber deciding
   * anything about a booking is usually asking "have they no-showed before?"
   * or "are they already coming back Thursday?", and both answers used to mean
   * leaving the sheet for the client page.
   */
  history: { previous: DetailHistoryItem[]; upcoming: DetailHistoryItem[] };
  payment: AppointmentPaymentSnapshot;
  /**
   * When the barber closed the chair moment (`Appointment.paidAt`). Null = the
   * cut has never been checked out, which is the ONLY state in which "Start
   * checkout" is a real action - the endpoint is idempotent and 409s a second
   * attempt, so offering the button again would be offering a dead end.
   */
  checkedOutAt: string | null;
  /** False for anything Acuity owns, and for a terminal (canceled/done) row. */
  editable: boolean;
  /** Why editing is off, so the sheet can say it instead of hiding a button. */
  readOnlyReason: "external" | "not_editable" | null;
  /** Where to go and change it, when another system owns the schedule. */
  externalManageUrl: string | null;
}

/** Each platform's own appointment list — where a synced booking is managed. */
const ACUITY_MANAGE_URL = "https://secure.acuityscheduling.com/appointments.php";
const SQUARE_MANAGE_URL = "https://squareup.com/dashboard/appointments";

const APPT_STATUS: Record<string, string> = {
  PENDING: "pending",
  BOOKED: "upcoming",
  COMPLETED: "completed",
  CANCELED: "canceled",
  NO_SHOW: "no_show",
};
// RESCHEDULED -> upcoming: a synced reschedule UPDATES the same Visit row to
// its new time, so the row IS the live booking (same rule as the agenda).
const VISIT_STATUS: Record<string, string> = {
  SCHEDULED: "upcoming",
  COMPLETED: "completed",
  CANCELED: "canceled",
  NO_SHOW: "no_show",
  RESCHEDULED: "upcoming",
};

function fullName(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

/**
 * A number a human can read, from the E.164 we store. National format for a
 * US number ("(201) 555-0134"), international for everything else. Falls back
 * to the stored string rather than dropping a number we DO have.
 */
function phoneDisplay(e164: string | null): string | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === "US" ? parsed.formatNational() : parsed.formatInternational();
}

/**
 * Resolve the ONE phone and ONE email the sheet will act on.
 *
 * Precedence matches how the app actually reaches people, so a barber tapping
 * Text hits the same number a reminder would:
 *   - PHONE: the client record first. That is the SMS channel of record
 *     (`appointmentNotify` texts `client.phone`), and it is the field that is
 *     guaranteed E.164 — the appointment's own copy is whatever the booker
 *     typed and is only used when there is no client row at all (a walk-in).
 *   - EMAIL: the appointment's typed address first, falling back to the
 *     client's — the same precedence the confirmation email uses.
 *
 * A phone that never parsed to E.164 is deliberately dropped rather than shown:
 * a `tel:` link built from "call me!!" is a broken action, and an action that
 * cleanly disappears is better than one that fails in the barber's hand.
 */
function resolveContact(input: {
  apptPhone?: string | null;
  apptEmail?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
}): DetailContact {
  const rawPhone = input.clientPhone ?? input.apptPhone ?? null;
  const phone = rawPhone ? (parsePhoneNumberFromString(rawPhone, "US")?.number ?? null) : null;
  const email = (input.apptEmail ?? input.clientEmail ?? null)?.trim() || null;
  return { phone, phoneDisplay: phoneDisplay(phone), email };
}

/**
 * The add-on snapshot is untyped JSON that may predate the current shape. Read
 * defensively — same rule (and same reason) as the agenda's copy.
 */
function detailAddOns(raw: Prisma.JsonValue | null): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id === "string" && typeof name === "string") out.push({ id, name });
  }
  return out;
}

function durationMin(startsAt: Date, endsAt: Date | null): number | null {
  if (!endsAt) return null;
  const mins = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  return mins > 0 ? mins : null;
}

/**
 * WHICH other system owns this shop's synced bookings, and where to go and
 * change one. Read from the connections that actually EXIST rather than
 * assumed, so a Square shop is never sent to fix something in Acuity — and a
 * shop with no live connection at all gets a truthful label and no link,
 * instead of a button that lands on a stranger's login page.
 */
async function externalSource(
  shopId: string,
): Promise<{ label: string; manageUrl: string | null }> {
  const [acuity, square] = await Promise.all([
    prisma.acuityConnection.findFirst({ where: { shopId }, select: { id: true } }),
    prisma.squareConnection.findFirst({ where: { shopId }, select: { id: true } }),
  ]);
  if (acuity) return { label: "Acuity", manageUrl: ACUITY_MANAGE_URL };
  if (square) return { label: "Square", manageUrl: SQUARE_MANAGE_URL };
  return { label: "your booking platform", manageUrl: null };
}

/** How many past and future bookings the sheet shows. Three is a glance. */
const HISTORY_LIMIT = 3;

/**
 * THE REST OF THIS CLIENT'S BOOK — past and future, native and synced.
 *
 * Shop-scoped and client-scoped like everything else here, and it carries no
 * contact detail at all: a history line is a date, a service and a status.
 *
 * 🔴 `appointment: null` ON THE VISIT SIDE IS THE DEDUPE, and it is the same
 * predicate the agenda uses. A native booking that Acuity later took over
 * exists as BOTH an Appointment and a Visit; the Appointment row is the one
 * that represents it, so only visits with no appointment behind them are
 * added. Filtering BOTH sides looks symmetrical and makes a promoted booking
 * vanish from its own client's history — which is how this was first written,
 * and what the dedupe test now pins down.
 */
async function clientHistory(
  shopId: string,
  clientId: string | null,
  exclude: { id: string; source: "appointment" | "visit" },
  now: Date,
): Promise<{ previous: DetailHistoryItem[]; upcoming: DetailHistoryItem[] }> {
  if (!clientId) return { previous: [], upcoming: [] };

  const apptSelect = {
    id: true,
    status: true,
    startsAt: true,
    priceAtBooking: true,
    service: { select: { name: true } },
  };
  const visitSelect = {
    id: true,
    status: true,
    scheduledAt: true,
    price: true,
    serviceName: true,
  };
  type ApptRow = {
    id: string;
    status: string;
    startsAt: Date;
    priceAtBooking: Prisma.Decimal | null;
    service: { name: string } | null;
  };
  type VisitRow = {
    id: string;
    status: string;
    scheduledAt: Date;
    price: Prisma.Decimal | null;
    serviceName: string | null;
  };

  const db = forShop(shopId);
  const apptWhere = { shopId, clientId, id: { not: exclude.id } };
  const visitWhere = { shopId, clientId, appointment: null, id: { not: exclude.id } };
  // Only a booking that is still ON the schedule counts as upcoming; a future
  // row that was canceled is history, and belongs in neither list.
  // `as const` because Prisma types these as enum unions, not string — vitest
  // transpiles without checking, so a bare string[] here compiles locally and
  // fails the Railway build.
  const APPT_LIVE = ["BOOKED", "PENDING"] as const;
  const VISIT_LIVE = ["SCHEDULED", "RESCHEDULED"] as const;

  const [pastAppts, pastVisits, nextAppts, nextVisits] = (await Promise.all([
    db.appointment.findMany({
      where: { ...apptWhere, startsAt: { lt: now } },
      select: apptSelect,
      orderBy: { startsAt: "desc" },
      take: HISTORY_LIMIT,
    }),
    db.visit.findMany({
      where: { ...visitWhere, scheduledAt: { lt: now } },
      select: visitSelect,
      orderBy: { scheduledAt: "desc" },
      take: HISTORY_LIMIT,
    }),
    db.appointment.findMany({
      where: { ...apptWhere, startsAt: { gte: now }, status: { in: [...APPT_LIVE] } },
      select: apptSelect,
      orderBy: { startsAt: "asc" },
      take: HISTORY_LIMIT,
    }),
    db.visit.findMany({
      where: { ...visitWhere, scheduledAt: { gte: now }, status: { in: [...VISIT_LIVE] } },
      select: visitSelect,
      orderBy: { scheduledAt: "asc" },
      take: HISTORY_LIMIT,
    }),
  ])) as unknown as [ApptRow[], VisitRow[], ApptRow[], VisitRow[]];

  const fromAppt = (a: ApptRow): DetailHistoryItem => ({
    id: a.id,
    source: "appointment",
    startsAt: a.startsAt.toISOString(),
    serviceName: a.service?.name ?? null,
    status: APPT_STATUS[a.status] ?? "upcoming",
    price: a.priceAtBooking == null ? null : Number(a.priceAtBooking),
  });
  const fromVisit = (v: VisitRow): DetailHistoryItem => ({
    id: v.id,
    source: "visit",
    startsAt: v.scheduledAt.toISOString(),
    serviceName: v.serviceName,
    status: VISIT_STATUS[v.status] ?? "upcoming",
    price: v.price == null ? null : Number(v.price),
  });

  // Each side was taken separately, so the merged list is re-sorted and
  // re-trimmed: three natives and three synced must still yield three lines.
  const previous = [...pastAppts.map(fromAppt), ...pastVisits.map(fromVisit)]
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, HISTORY_LIMIT);
  const upcoming = [...nextAppts.map(fromAppt), ...nextVisits.map(fromVisit)]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, HISTORY_LIMIT);
  return { previous, upcoming };
}

export function registerAppointmentDetail(router: Router): void {
  router.get("/appointments/:id/detail", async (req, res) => {
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { timezone: true },
    });

    // forShop() is a hand-curated tenant wrapper that erases nested-relation
    // types from a `select`, so the shape is spelled out and cast. The cast
    // names exactly the fields requested below.
    const appt = (await forShop(shopId).appointment.findFirst({
      where: { id: req.params.id!, shopId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        endsAt: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        clientId: true,
        priceAtBooking: true,
        notes: true,
        addOns: true,
        checkInStatus: true,
        visitId: true,
        // The Visit's source namespace is what decides ownership (see
        // engines/visitOrigin.ts) - `visitId` alone never can.
        visit: { select: { acuityAppointmentId: true } },
        paidAmount: true,
        paidMethod: true,
        paidAt: true,
        cardOnFile: { select: { brand: true, last4: true, status: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
        client: {
          select: {
            phone: true,
            email: true,
            optedOut: true,
            smsConsentAt: true,
          },
        },
      },
    })) as unknown as {
      id: string;
      status: string;
      startsAt: Date;
      endsAt: Date;
      firstName: string;
      lastName: string | null;
      phone: string | null;
      email: string | null;
      clientId: string | null;
      priceAtBooking: Prisma.Decimal | null;
      notes: string | null;
      addOns: Prisma.JsonValue | null;
      checkInStatus: string | null;
      visitId: string | null;
      visit: { acuityAppointmentId: string } | null;
      paidAmount: Prisma.Decimal | null;
      paidMethod: string | null;
      paidAt: Date | null;
      cardOnFile: { brand: string | null; last4: string | null; status: string } | null;
      service: { name: string } | null;
      staff: { name: string } | null;
      client: {
        phone: string | null;
        email: string | null;
        optedOut: boolean;
        smsConsentAt: Date | null;
      } | null;
    } | null;

    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // The Payment row is read separately for the same typing reason.
    const payment = await prisma.payment.findFirst({
      where: { appointmentId: appt.id, shopId },
      select: {
        status: true,
        amount: true,
        capturedAmount: true,
        refundedAmount: true,
      },
    });

    // 🔴 OWNERSHIP IS NOT "HAS A VISIT". Every COMPLETED native booking is
    // linked to a Visit by the completion promoter (its loyalty record), so
    // `visitId !== null` used to turn every finished ChairBack booking into
    // "Managed in Acuity / No ChairBack payment recorded" — including one whose
    // $10 deposit was collected and sitting in the barber's Stripe balance
    // (FadesByMikey, 2026-09-02). A booking is another platform's only when
    // its Visit came FROM that platform. Same predicate the edit endpoint
    // refuses on, so the sheet's read-only state and the server's refusal can
    // never disagree.
    const external = appointmentOwnedByPlatform(appt);
    const price = appt.priceAtBooking == null ? null : Number(appt.priceAtBooking);
    const status = APPT_STATUS[appt.status] ?? "upcoming";
    const editable = !external && (appt.status === "BOOKED" || appt.status === "PENDING");
    const source = external
      ? await externalSource(shopId)
      : { label: "ChairBack", manageUrl: null };
    const history = await clientHistory(
      shopId,
      appt.clientId,
      { id: appt.id, source: "appointment" },
      new Date(),
    );

    const detail: AppointmentDetail = {
      id: appt.id,
      source: "appointment",
      origin: external ? "external" : "chairback",
      originLabel: source.label,
      status,
      checkInStatus: appt.checkInStatus,
      clientId: appt.clientId,
      clientName: fullName(appt.firstName, appt.lastName) || "Client",
      serviceName: appt.service?.name ?? null,
      staffName: appt.staff?.name ?? null,
      startsAt: appt.startsAt.toISOString(),
      endsAt: appt.endsAt.toISOString(),
      durationMin: durationMin(appt.startsAt, appt.endsAt),
      timezone: shop?.timezone ?? "America/New_York",
      price,
      notes: appt.notes,
      addOns: detailAddOns(appt.addOns),
      contact: resolveContact({
        apptPhone: appt.phone,
        apptEmail: appt.email,
        clientPhone: appt.client?.phone,
        clientEmail: appt.client?.email,
      }),
      sms: smsReach(appt.client ?? null),
      history,
      payment: appointmentPaymentSnapshot({
        price,
        payment,
        chairPaid: appt.paidAmount == null ? null : Number(appt.paidAmount),
        chairMethod: appt.paidMethod,
        chairCheckedOut: appt.paidAt !== null,
        external,
        cardOnFile: appt.cardOnFile ?? null,
      }),
      checkedOutAt: appt.paidAt ? appt.paidAt.toISOString() : null,
      editable,
      readOnlyReason: editable ? null : external ? "external" : "not_editable",
      externalManageUrl: source.manageUrl,
    };
    res.json(detail);
  });

  /**
   * A SYNCED booking. Acuity/Square own the schedule and the money; ChairBack
   * owns the client record the sync wrote, so contact is the one thing here
   * that is genuinely ours to show and act on.
   */
  router.get("/visits/:id/detail", async (req, res) => {
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { timezone: true },
    });

    const visit = (await forShop(shopId).visit.findFirst({
      where: { id: req.params.id!, shopId },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        endAt: true,
        price: true,
        serviceName: true,
        clientId: true,
        client: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            optedOut: true,
            smsConsentAt: true,
          },
        },
      },
    })) as unknown as {
      id: string;
      status: string;
      scheduledAt: Date;
      endAt: Date | null;
      price: Prisma.Decimal | null;
      serviceName: string | null;
      clientId: string;
      client: {
        firstName: string | null;
        lastName: string | null;
        phone: string | null;
        email: string | null;
        optedOut: boolean;
        smsConsentAt: Date | null;
      } | null;
    } | null;

    if (!visit) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const price = visit.price == null ? null : Number(visit.price);
    const source = await externalSource(shopId);
    const history = await clientHistory(
      shopId,
      visit.clientId,
      { id: visit.id, source: "visit" },
      new Date(),
    );
    const detail: AppointmentDetail = {
      id: visit.id,
      source: "visit",
      origin: "external",
      originLabel: source.label,
      status: VISIT_STATUS[visit.status] ?? "upcoming",
      checkInStatus: null,
      clientId: visit.clientId,
      clientName:
        fullName(visit.client?.firstName ?? null, visit.client?.lastName ?? null) ||
        "Booked elsewhere",
      serviceName: visit.serviceName,
      staffName: null, // a Visit carries no staff — the source doesn't send one
      startsAt: visit.scheduledAt.toISOString(),
      endsAt: visit.endAt ? visit.endAt.toISOString() : null,
      durationMin: durationMin(visit.scheduledAt, visit.endAt),
      timezone: shop?.timezone ?? "America/New_York",
      price,
      notes: null, // barber notes live on native bookings only
      addOns: [],
      // The whole point of the synced sheet: the contact the ingest matched to
      // this shop's own client row, already normalized to E.164 by `toE164`.
      contact: resolveContact({
        clientPhone: visit.client?.phone,
        clientEmail: visit.client?.email,
      }),
      // A synced client's consent is a REAL ChairBack fact even though the
      // booking isn't ours: the ingest never captures an opt-in, so this is
      // almost always `no_consent` — which is exactly why the sheet must not
      // offer Text as though it were live.
      sms: smsReach(visit.client ?? null),
      history,
      // `external: true` — ChairBack has no payment record for a booking it did
      // not take money for, and will not invent one.
      payment: appointmentPaymentSnapshot({
        price,
        payment: null,
        chairPaid: null,
        chairMethod: null,
        chairCheckedOut: false,
        external: true,
      }),
      checkedOutAt: null,
      editable: false,
      readOnlyReason: "external",
      externalManageUrl: source.manageUrl,
    };
    res.json(detail);
  });
}
