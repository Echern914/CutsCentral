import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { earnPunchForVisit } from "../services/punch.js";
import { recomputeCadence } from "./cadence.js";

/**
 * Acuity never fires a "completed" event. A visit becomes COMPLETED once its end
 * time has passed and it wasn't canceled. This job promotes such visits, earns a
 * punch (idempotent), and recomputes the client's cadence.
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
    select: { id: true, shopId: true, clientId: true },
  });

  for (const v of due) {
    await prisma.visit.update({
      where: { id: v.id },
      data: { status: "COMPLETED", completedAt: now },
    });
    await earnPunchForVisit(v.shopId, v.clientId, v.id);
    await recomputeCadence(v.shopId, v.clientId);
  }

  if (due.length) logger.info({ promoted: due.length }, "promoted completed visits");
  return due.length;
}
