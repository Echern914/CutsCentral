import { prisma, runWithShop, type Shop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "./acuity/clientKey.js";
import { getAcuityClientForShop } from "./acuity/client.js";
import { appointmentHasSmsConsent } from "./acuity/consent.js";
import { resolveStatus } from "./acuity/mapping.js";
import { recomputeCadence } from "./engines/cadence.js";
import { clawBackVisitEarn, earnPunchForVisitInTx } from "./services/punch.js";
import { logger } from "./logger.js";
import type { AcuityAppointment } from "./acuity/types.js";

/** Parse a date string, returning null for missing OR unparseable values. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Shared idempotent ingest path for BOTH the webhook receiver and the backfill.
 *
 * All writes run in a SINGLE runWithShop transaction: the RLS shop context is
 * set once, the client + visit + (optional) punch upserts are atomic, and it's
 * one network round-trip instead of three. Re-delivery / re-runs are safe via
 * the unique constraints.
 */
export async function ingestAppointment(
  shop: Shop,
  action: string,
  acuityId: string,
  prefetched?: AcuityAppointment,
): Promise<void> {
  // Webhook payloads are skeletal - fetch the full appointment unless the
  // caller (backfill) already has it. (Outside the tx - it's a network call.)
  const appt =
    prefetched ??
    (await (await getAcuityClientForShop(shop.id)).getAppointment(acuityId));

  const acuityClientKey = deriveAcuityClientKey(appt);
  const phone = toE164(appt.phone);
  const status = resolveStatus(appt, action);
  // Acuity's endTime (and occasionally other fields) can be present but
  // unparseable - `new Date("...")` then yields an Invalid Date, which Postgres
  // rejects and crashes the whole upsert, silently dropping the appointment.
  // Parse defensively: a bad optional date becomes null, not a thrown ingest.
  const scheduledAt = parseDate(appt.datetime);
  if (!scheduledAt) {
    // datetime is required; without a valid one there's no usable visit. Skip
    // rather than poison the backfill for every other appointment.
    logger.warn(
      { shopId: shop.id, acuityId, datetime: appt.datetime },
      "skipping appointment with unparseable datetime",
    );
    return;
  }
  const endAt = parseDate(appt.endTime);
  const priceNum = appt.price != null ? Number(appt.price) : null;
  const price = priceNum != null && Number.isFinite(priceNum) ? priceNum : null;
  // TCPA consent from the intake form (if the barber added the checkbox and the
  // client ticked it). Only ever GRANTS consent - never clears it - and only
  // when not already on file (first consent wins; a later booking without the
  // box must not revoke an earlier opt-in).
  const consented = appointmentHasSmsConsent(appt);

  const { clientId, clawedBack } = await runWithShop(shop.id, async (tx) => {
    const client = await tx.client.upsert({
      where: { shopId_acuityClientKey: { shopId: shop.id, acuityClientKey } },
      create: {
        shopId: shop.id,
        acuityClientKey,
        magicToken: randomToken(),
        firstName: appt.firstName ?? null,
        lastName: appt.lastName ?? null,
        phone,
        email: appt.email ?? null,
        smsConsentAt: consented ? scheduledAt : null,
        smsConsentSource: consented ? "acuity_intake" : null,
      },
      update: {
        firstName: appt.firstName ?? undefined,
        lastName: appt.lastName ?? undefined,
        phone: phone ?? undefined,
        email: appt.email ?? undefined,
      },
    });

    // Existing client + fresh consent on this booking: stamp it, but only if
    // none is recorded yet (guarded update = never overwrite an earlier source).
    if (consented) {
      await tx.client.updateMany({
        where: { id: client.id, smsConsentAt: null },
        data: { smsConsentAt: scheduledAt, smsConsentSource: "acuity_intake" },
      });
    }

    // A re-delivered/"changed" event resolves to SCHEDULED (resolveStatus never
    // returns COMPLETED) - it must NOT downgrade a visit the promotion job
    // already completed, or the punch/cadence history silently loses the visit.
    // Terminal cancel/no-show states still override (a retroactive cancel is real).
    const existing = await tx.visit.findUnique({
      where: {
        shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: acuityId },
      },
      select: { status: true },
    });
    const keepCompleted =
      existing?.status === "COMPLETED" &&
      status !== "CANCELED" &&
      status !== "NO_SHOW";
    // A retroactive cancel/no-show on an already-promoted visit: the punch it
    // earned is phantom (the cut never happened) and must be clawed back.
    const revokeCompleted =
      existing?.status === "COMPLETED" &&
      (status === "CANCELED" || status === "NO_SHOW");

    const visit = await tx.visit.upsert({
      where: {
        shopId_acuityAppointmentId: { shopId: shop.id, acuityAppointmentId: acuityId },
      },
      create: {
        shopId: shop.id,
        clientId: client.id,
        acuityAppointmentId: acuityId,
        status,
        scheduledAt,
        endAt,
        price: price ?? undefined,
        serviceName: appt.type ?? null,
        noShow: appt.noShow ?? false,
        canceledAt: status === "CANCELED" ? new Date() : null,
      },
      update: {
        status: keepCompleted ? undefined : status,
        scheduledAt,
        endAt,
        price: price ?? undefined,
        serviceName: appt.type ?? undefined,
        noShow: appt.noShow ?? false,
        canceledAt: status === "CANCELED" ? new Date() : null,
        completedAt: revokeCompleted ? null : undefined,
      },
    });

    if (revokeCompleted) {
      // A retroactive cancel/no-show: the phantom visit's punch (and any barber
      // corrections layered on it) must come back out. Shared with the dashboard
      // delete/edit-visit paths so the claw-back logic can never drift between them.
      await clawBackVisitEarn(tx, shop.id, visit.id);
    }

    // If a visit arrives already COMPLETED, earn punches here (normally the
    // status-promotion job does this). Idempotent via PunchLedger.visitId;
    // amount follows the shop's earn rules.
    if (visit.status === "COMPLETED") {
      await earnPunchForVisitInTx(
        tx,
        shop,
        client.id,
        visit.id,
        visit.serviceName,
        visit.completedAt ?? visit.scheduledAt,
      );
    }

    return { clientId: client.id, clawedBack: revokeCompleted };
  });

  // The completed-visit set changed: lastVisitAt / median cadence / nextExpectedAt
  // were all advanced by the phantom visit and must be recomputed. (Outside the
  // tx - recomputeCadence opens its own shop-scoped transaction.)
  if (clawedBack) await recomputeCadence(shop.id, clientId);
}

/** Re-export prisma for callers that need a raw lookup near ingest. */
export { prisma };
