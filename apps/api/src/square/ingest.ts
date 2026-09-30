import { prisma, runWithShop, type Shop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { recomputeCadence } from "../engines/cadence.js";
import { clawBackVisitEarn, earnPunchForVisitInTx } from "../services/punch.js";
import { recordEmailSuppression } from "../services/emailSuppression.js";
import { logger } from "../logger.js";
import { getSquareClientForShop, type SquareClient } from "./client.js";
import { resolveSquareStatus } from "./mapping.js";
import type { SquareBooking, SquareCustomer } from "./types.js";

/**
 * Square analog of acuity/../ingest.ts:ingestAppointment. A Square Booking
 * becomes a Visit through the SAME idempotent path: client upsert -> visit upsert
 * (keyed by the namespaced source id) -> earn-on-completed -> claw-back-on-cancel
 * -> cadence (the punch message is the completion job's). The whole loyalty pipeline downstream of Visit is
 * REUSED VERBATIM — Square is just another source that writes Visit rows.
 *
 * Visit idempotency reuses Visit's @@unique([shopId, acuityAppointmentId]) with a
 * "square:{bookingId}" namespace (the same trick native booking uses with
 * "booking:{id}" and manual visits use with "manual:{id}"), so re-delivery /
 * re-runs never duplicate or double-earn.
 *
 * CONSENT differs from Acuity: Square bookings have no intake-form SMS-consent
 * checkbox, so Square-sourced clients get smsConsentAt = null and rely on the
 * existing self-serve (rewards page) / barber-attestation consent paths. We never
 * fabricate consent. The one consent fact Square does carry - a customer's
 * marketing-email unsubscribe - is carried over, and only ever in that direction.
 */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The half hour utilization assumes when Square gives no length at all. */
const FALLBACK_DURATION_MIN = 30;

/**
 * How long the chair is taken, in minutes: EVERY segment, and the gaps Square
 * leaves between them. A haircut + beard booking is two segments, and reading
 * only the first made the Visit end halfway through - the slot engine then
 * offered the second half of an appointment that was still in the chair.
 * The last segment's intermission is not counted: nothing follows it.
 */
export function squareBookingMinutes(booking: Pick<SquareBooking, "appointment_segments">): number {
  const segments = booking.appointment_segments;
  let total = 0;
  segments.forEach((s, i) => {
    total += Math.max(0, s.duration_minutes ?? 0);
    if (i < segments.length - 1) total += Math.max(0, s.intermission_minutes ?? 0);
  });
  return total > 0 ? total : FALLBACK_DURATION_MIN;
}

/** Pull contact fields off the Square Customer for the client mapping. */
function contactFromCustomer(customer: SquareCustomer | null): {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  emailUnsubscribed: boolean;
} {
  return {
    firstName: customer?.given_name ?? null,
    lastName: customer?.family_name ?? null,
    phone: toE164(customer?.phone_number),
    email: customer?.email_address ?? null,
    emailUnsubscribed: customer?.preferences?.email_unsubscribed === true,
  };
}

/**
 * Optional shared state for BULK callers (backfill, the resync sweep). A
 * webhook ingests one booking and passes nothing; a sweep ingests hundreds and
 * would otherwise re-read + decrypt the shop's OAuth token, and re-fetch the
 * same customers, once per booking.
 */
export interface SquareIngestDeps {
  /** Build the authed client ONCE per sweep instead of per booking. */
  client?: SquareClient;
  /** customer_id -> customer (or null when the fetch failed), per sweep. */
  customers?: Map<string, SquareCustomer | null>;
}

export async function ingestSquareBooking(
  shop: Shop,
  bookingId: string,
  prefetched?: SquareBooking,
  deps?: SquareIngestDeps,
): Promise<void> {
  const client = deps?.client ?? (await getSquareClientForShop(shop.id));
  const booking = prefetched ?? (await client.getBooking(bookingId));

  // Bookings only carry a customer_id; fetch the customer for name/phone/email.
  // Best-effort: a missing customer becomes an anon client (still trackable).
  //
  // A bulk caller passes a cache: a barbershop's window is mostly REPEAT
  // clients, so the same handful of customer_ids recur across hundreds of
  // bookings and this collapses a request-per-booking into one per person.
  // Negative results are cached too - a deleted customer must not be retried
  // on every one of their past bookings, every sweep.
  let customer: SquareCustomer | null = null;
  if (booking.customer_id) {
    const cache = deps?.customers;
    if (cache?.has(booking.customer_id)) {
      customer = cache.get(booking.customer_id) ?? null;
    } else {
      try {
        customer = await client.getCustomer(booking.customer_id);
      } catch (err) {
        logger.warn({ err, shopId: shop.id, bookingId }, "square customer fetch failed");
      }
      cache?.set(booking.customer_id, customer);
    }
  }
  const contact = contactFromCustomer(customer);

  const clientKey = deriveAcuityClientKey({
    phone: contact.phone,
    email: contact.email,
    firstName: contact.firstName,
    lastName: contact.lastName,
  });
  const status = resolveSquareStatus(booking);
  const scheduledAt = parseDate(booking.start_at);
  if (!scheduledAt) {
    logger.warn(
      { shopId: shop.id, bookingId, start_at: booking.start_at },
      "skipping square booking with unparseable start_at",
    );
    return;
  }
  // Square bookings don't inline an end time or price; the end is the start
  // plus every segment (squareBookingMinutes). Service name needs a Catalog
  // lookup we skip in v1 (null is fine — punches earn on the shop's default
  // punchesPerVisit).
  // Never null: a null endAt is invisible to the slot engine's `endAt: { gt }`
  // busy-join (Prisma gt excludes NULL) and the visit would block nothing.
  const endAt = new Date(scheduledAt.getTime() + squareBookingMinutes(booking) * 60_000);
  const sourceId = `square:${booking.id}`;
  // When it was cancelled, as near as Square says: its last update. A sync
  // that re-reads a cancelled booking must not move the date to "now" - the
  // sweep re-reads every booking in its window every half hour, and a
  // connect-time import would stamp years-old cancellations with today.
  const cancelledAt = status === "CANCELED" ? (parseDate(booking.updated_at) ?? new Date()) : null;

  const { clientId, clawedBack } = await runWithShop(shop.id, async (tx) => {
    const dbClient = await tx.client.upsert({
      where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey: clientKey } },
      create: {
        shopId: shop.id,
        acuityClientKey: clientKey,
        magicToken: randomToken(),
        firstName: contact.firstName,
        lastName: contact.lastName,
        phone: contact.phone,
        email: contact.email,
        // No Square intake consent checkbox -> never auto-consent.
        smsConsentAt: null,
        smsConsentSource: null,
      },
      update: {
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        phone: contact.phone ?? undefined,
        email: contact.email ?? undefined,
      },
    });

    // 🔴 AN UNSUBSCRIBE CARRIES OVER; IT IS NEVER UNDONE HERE. A customer who
    // opted out of marketing email in Square is opted out here too (broadcasts
    // only - appointment messages never read this). Square's `false` means
    // nothing to ChairBack: it never clears an opt-out, whether it came from
    // Square or from ChairBack's own unsubscribe link, and the guard keeps the
    // date of the FIRST opt-out rather than re-stamping it on every sync.
    // Square gives no date for its flag, so the first time ChairBack sees it
    // is the date recorded.
    if (contact.emailUnsubscribed) {
      await tx.client.updateMany({
        where: { id: dbClient.id, emailOptedOut: false },
        data: { emailOptedOut: true, emailOptedOutAt: new Date() },
      });
      // And the address Square's flag is about, so it stays unsubscribed
      // whichever record carries it later (#514).
      await recordEmailSuppression(tx, {
        shopId: shop.id,
        address: contact.email,
        kind: "unsubscribe",
        source: "square_sync",
      });
    }

    // A re-delivered booking.updated resolves to SCHEDULED and must NOT downgrade
    // a visit the promotion job already COMPLETED. Terminal cancel/no-show still
    // override (a retroactive cancel is real and must claw back the punch).
    const existing = await tx.visit.findUnique({
      where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
      select: { status: true, canceledAt: true },
    });
    const keepCompleted =
      existing?.status === "COMPLETED" && status !== "CANCELED" && status !== "NO_SHOW";
    const revokeCompleted =
      existing?.status === "COMPLETED" && (status === "CANCELED" || status === "NO_SHOW");

    const visit = await tx.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
      create: {
        shopId: shop.id,
        clientId: dbClient.id,
        acuityAppointmentId: sourceId,
        status,
        scheduledAt,
        endAt,
        serviceName: null,
        noShow: status === "NO_SHOW",
        canceledAt: cancelledAt,
      },
      update: {
        status: keepCompleted ? undefined : status,
        scheduledAt,
        endAt,
        noShow: status === "NO_SHOW",
        // The first date it was seen cancelled stands; a booking no longer
        // cancelled (re-accepted in Square) has none.
        canceledAt: cancelledAt ? (existing?.canceledAt ?? cancelledAt) : null,
        completedAt: revokeCompleted ? null : undefined,
      },
    });

    if (revokeCompleted) {
      await clawBackVisitEarn(tx, shop.id, visit.id);
    }

    // Square never delivers a booking as already COMPLETED (its statuses don't
    // include "completed"), so earn happens via the status-promotion job once
    // start/end passes. Kept here for symmetry with Acuity in case a future
    // status maps to COMPLETED.
    if (visit.status === "COMPLETED") {
      await earnPunchForVisitInTx(
        tx,
        shop,
        dbClient.id,
        visit.id,
        visit.serviceName,
        visit.completedAt ?? visit.scheduledAt,
      );
    }

    return { clientId: dbClient.id, clawedBack: revokeCompleted };
  });

  if (clawedBack) await recomputeCadence(shop.id, clientId);

  // An earn here is never announced: it can only be for a visit that was
  // already completed - history (engines/syncedVisitTrust.ts, rule 2).
}
