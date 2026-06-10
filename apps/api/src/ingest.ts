import { prisma, runWithShop, type Shop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "./acuity/clientKey.js";
import { getAcuityClientForShop } from "./acuity/client.js";
import { resolveStatus } from "./acuity/mapping.js";
import type { AcuityAppointment } from "./acuity/types.js";

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
  const scheduledAt = new Date(appt.datetime);
  const endAt = appt.endTime ? new Date(appt.endTime) : null;
  const price = appt.price ? Number(appt.price) : null;

  await runWithShop(shop.id, async (tx) => {
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
      },
      update: {
        firstName: appt.firstName ?? undefined,
        lastName: appt.lastName ?? undefined,
        phone: phone ?? undefined,
        email: appt.email ?? undefined,
      },
    });

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
      },
    });

    // If a visit arrives already COMPLETED, earn a punch here (normally the
    // status-promotion job does this). Idempotent via PunchLedger.visitId.
    if (visit.status === "COMPLETED") {
      const existing = await tx.punchLedger.findUnique({ where: { visitId: visit.id } });
      if (!existing) {
        const agg = await tx.punchLedger.aggregate({
          where: { shopId: shop.id, clientId: client.id },
          _sum: { punchesEarned: true, punchesRedeemed: true },
        });
        const balance =
          (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
        await tx.punchLedger.create({
          data: {
            shopId: shop.id,
            clientId: client.id,
            visitId: visit.id,
            punchesEarned: 1,
            runningBalance: balance + 1,
            note: "visit",
          },
        });
      }
    }
  });
}

/** Re-export prisma for callers that need a raw lookup near ingest. */
export { prisma };
