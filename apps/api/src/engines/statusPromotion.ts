import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { earnPunchForVisit } from "../services/punch.js";
import { recomputeCadence } from "./cadence.js";

/**
 * Acuity never fires a "completed" event. A visit becomes COMPLETED once its end
 * time has passed and it wasn't canceled. This job promotes such visits, earns
 * punches per the shop's earn rules (idempotent), and recomputes the client's
 * cadence.
 *
 * Runs across all shops; idempotent (promoted rows no longer match the filter).
 */
export async function promoteCompletedVisits(now = new Date()): Promise<number> {
  const due = await prisma.visit.findMany({
    where: {
      status: { in: ["SCHEDULED", "RESCHEDULED"] },
      endAt: { lt: now },
      canceledAt: null,
      noShow: false, // a no-show never completes or earns a punch
    },
    select: { id: true, shopId: true, clientId: true, serviceName: true, endAt: true },
  });
  if (due.length === 0) return 0;

  // One shop lookup for the whole batch - the earn rate is per shop.
  const shops = await prisma.shop.findMany({
    where: { id: { in: [...new Set(due.map((v) => v.shopId))] } },
    select: { id: true, punchesPerVisit: true },
  });
  const shopById = new Map(shops.map((s) => [s.id, s]));

  for (const v of due) {
    await prisma.visit.update({
      where: { id: v.id },
      data: { status: "COMPLETED", completedAt: now },
    });
    // The shop must exist - visits cascade-delete with their shop. The visit
    // "happened" when it ended, which is what promo windows check against.
    await earnPunchForVisit(
      shopById.get(v.shopId)!,
      v.clientId,
      v.id,
      v.serviceName,
      v.endAt ?? now,
    );
    await recomputeCadence(v.shopId, v.clientId);
  }

  logger.info({ promoted: due.length }, "promoted completed visits");
  return due.length;
}
