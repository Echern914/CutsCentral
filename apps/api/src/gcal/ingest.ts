import { runWithShop, type Shop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { recomputeCadence } from "../engines/cadence.js";
import { clawBackVisitEarn } from "../services/punch.js";
import { logger } from "../logger.js";
import { mapGcalEvent, shouldIngestGcalEvent } from "./mapping.js";
import type { GcalEvent } from "./types.js";

/**
 * Google Calendar analog of square/ingest.ts:ingestSquareBooking. A calendar
 * event becomes a Visit through the SAME idempotent path: client upsert ->
 * visit upsert (keyed by the namespaced source id) -> claw-back-on-cancel ->
 * cadence. The loyalty pipeline downstream of Visit is REUSED VERBATIM — the
 * calendar is just another source that writes Visit rows.
 *
 * Visit idempotency reuses Visit's @@unique([shopId, acuityAppointmentId]) with
 * a "gcal:{eventId}" namespace (recurring events are expanded server-side via
 * singleEvents=true, so each instance id is stable and unique), making sweep
 * re-runs and full resyncs safe.
 *
 * TWO calendar-specific differences from Square:
 *  - deletions arrive as TOMBSTONES ({id, status:"cancelled"}, nothing else),
 *    so cancellation is an update-only path keyed on the source id;
 *  - there is no completed/no-show signal at all — a live event ingests as
 *    SCHEDULED and the statusPromotion job flips it to COMPLETED (and earns the
 *    punch) once its end time passes, exactly like Square live bookings.
 *
 * CONSENT: calendar events carry no SMS-consent signal, so gcal-sourced clients
 * get smsConsentAt = null and rely on the existing self-serve (rewards page) /
 * barber-attestation consent paths. We never fabricate consent.
 */
export async function ingestGcalEvent(shop: Shop, event: GcalEvent): Promise<void> {
  const sourceId = `gcal:${event.id}`;

  // Deleted on the calendar => the booking was cancelled. Tombstones carry no
  // details, so only an ALREADY-INGESTED visit can be cancelled; a tombstone
  // for an event we never saw (or filtered out) is a no-op.
  if (event.status === "cancelled") {
    const { clientId, clawedBack } = await runWithShop(shop.id, async (tx) => {
      const existing = await tx.visit.findUnique({
        where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
        select: { id: true, status: true, clientId: true },
      });
      if (!existing || existing.status === "CANCELED") {
        return { clientId: null, clawedBack: false };
      }
      // A retroactive delete of a visit the promotion job already COMPLETED is
      // real (the appointment didn't happen) and must claw back the punch.
      const revokeCompleted = existing.status === "COMPLETED";
      await tx.visit.update({
        where: { id: existing.id },
        data: {
          status: "CANCELED",
          canceledAt: new Date(),
          completedAt: revokeCompleted ? null : undefined,
        },
      });
      if (revokeCompleted) {
        await clawBackVisitEarn(tx, shop.id, existing.id);
      }
      return { clientId: existing.clientId, clawedBack: revokeCompleted };
    });
    if (clawedBack && clientId) await recomputeCadence(shop.id, clientId);
    return;
  }

  if (!shouldIngestGcalEvent(event)) return;
  const mapped = mapGcalEvent(event);
  if (!mapped) {
    logger.warn(
      { shopId: shop.id, eventId: event.id, start: event.start },
      "skipping gcal event with unparseable times",
    );
    return;
  }

  // Key preference: phone -> email -> anon slug. The seed keeps contact-less
  // events from collapsing into one anon:unknown client, but the STORED name is
  // only ever a parsed person name (never a raw event title).
  const clientKey = deriveAcuityClientKey({
    phone: mapped.phone,
    email: mapped.email,
    firstName: mapped.firstName ?? mapped.clientKeySeed,
    lastName: mapped.firstName ? mapped.lastName : null,
  });

  await runWithShop(shop.id, async (tx) => {
    const dbClient = await tx.client.upsert({
      where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey: clientKey } },
      create: {
        shopId: shop.id,
        acuityClientKey: clientKey,
        magicToken: randomToken(),
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        phone: mapped.phone,
        email: mapped.email,
        // No consent signal in a calendar event -> never auto-consent.
        smsConsentAt: null,
        smsConsentSource: null,
      },
      update: {
        firstName: mapped.firstName ?? undefined,
        lastName: mapped.lastName ?? undefined,
        phone: mapped.phone ?? undefined,
        email: mapped.email ?? undefined,
      },
    });

    // A re-synced event resolves to SCHEDULED and must NOT downgrade a visit
    // the promotion job already COMPLETED (e.g. the barber edits the title
    // after the fact). Cancellation is the tombstone path above, so there is
    // no terminal-status override to handle here.
    const existing = await tx.visit.findUnique({
      where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
      select: { status: true },
    });
    const keepCompleted = existing?.status === "COMPLETED";

    await tx.visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: sourceId } },
      create: {
        shopId: shop.id,
        clientId: dbClient.id,
        acuityAppointmentId: sourceId,
        status: "SCHEDULED",
        scheduledAt: mapped.scheduledAt,
        endAt: mapped.endAt,
        serviceName: mapped.serviceName,
      },
      update: {
        status: keepCompleted ? undefined : "SCHEDULED",
        scheduledAt: mapped.scheduledAt,
        endAt: mapped.endAt,
        serviceName: mapped.serviceName,
        // An un-cancelled (restored) event comes back as a live update.
        canceledAt: null,
      },
    });

    // Earn-on-completed is deliberately absent: a gcal event NEVER arrives as
    // COMPLETED (no such status exists), so punches earn exclusively via the
    // statusPromotion job once endAt passes — same as live Square bookings.
  });
}
