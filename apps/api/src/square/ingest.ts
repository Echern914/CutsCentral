import { prisma, runWithShop, type Shop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { recomputeCadence } from "../engines/cadence.js";
import { clawBackVisitEarn, earnPunchForVisitInTx } from "../services/punch.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { logger } from "../logger.js";
import { getSquareClientForShop } from "./client.js";
import { resolveSquareStatus } from "./mapping.js";
import type { SquareBooking, SquareCustomer } from "./types.js";

/**
 * Square analog of acuity/../ingest.ts:ingestAppointment. A Square Booking
 * becomes a Visit through the SAME idempotent path: client upsert -> visit upsert
 * (keyed by the namespaced source id) -> earn-on-completed -> claw-back-on-cancel
 * -> cadence -> loyalty SMS. The whole loyalty pipeline downstream of Visit is
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
 * fabricate consent.
 */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pull contact fields off the Square Customer for the client mapping. */
function contactFromCustomer(customer: SquareCustomer | null): {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
} {
  return {
    firstName: customer?.given_name ?? null,
    lastName: customer?.family_name ?? null,
    phone: toE164(customer?.phone_number),
    email: customer?.email_address ?? null,
  };
}

export async function ingestSquareBooking(
  shop: Shop,
  bookingId: string,
  prefetched?: SquareBooking,
): Promise<void> {
  const client = await getSquareClientForShop(shop.id);
  const booking = prefetched ?? (await client.getBooking(bookingId));

  // Bookings only carry a customer_id; fetch the customer for name/phone/email.
  // Best-effort: a missing customer becomes an anon client (still trackable).
  let customer: SquareCustomer | null = null;
  if (booking.customer_id) {
    try {
      customer = await client.getCustomer(booking.customer_id);
    } catch (err) {
      logger.warn({ err, shopId: shop.id, bookingId }, "square customer fetch failed");
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
  // Square bookings don't inline an end time or price; derive end from the first
  // segment's duration when present. Service name needs a Catalog lookup we skip
  // in v1 (null is fine — punches earn on the shop's default punchesPerVisit).
  const durationMin = booking.appointment_segments[0]?.duration_minutes ?? null;
  const endAt =
    durationMin != null ? new Date(scheduledAt.getTime() + durationMin * 60_000) : null;
  const sourceId = `square:${booking.id}`;

  const { clientId, clawedBack, earn } = await runWithShop(shop.id, async (tx) => {
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

    // A re-delivered booking.updated resolves to SCHEDULED and must NOT downgrade
    // a visit the promotion job already COMPLETED. Terminal cancel/no-show still
    // override (a retroactive cancel is real and must claw back the punch).
    const existing = await tx.visit.findUnique({
      where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
      select: { status: true },
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
        canceledAt: status === "CANCELED" ? new Date() : null,
      },
      update: {
        status: keepCompleted ? undefined : status,
        scheduledAt,
        endAt,
        noShow: status === "NO_SHOW",
        canceledAt: status === "CANCELED" ? new Date() : null,
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
    let earn = null;
    if (visit.status === "COMPLETED") {
      earn = await earnPunchForVisitInTx(
        tx,
        shop,
        dbClient.id,
        visit.id,
        visit.serviceName,
        visit.completedAt ?? visit.scheduledAt,
      );
    }

    return { clientId: dbClient.id, clawedBack: revokeCompleted, earn };
  });

  if (clawedBack) await recomputeCadence(shop.id, clientId);

  if (earn) {
    await notifyPunchEarned({
      shopId: shop.id,
      clientId,
      earned: earn.earned,
      balance: earn.balance,
      cardTypeId: earn.cardTypeId,
      cardName: earn.cardName,
    });
  }
}
