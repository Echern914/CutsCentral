import { apiEnv } from "@chairback/config";
import { Prisma, forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { sendPushToClient } from "../messaging/push.js";

/**
 * Barber -> client "come early" nudge on ONE upcoming appointment. PUSH-ONLY by
 * design - there is deliberately no SMS leg anywhere in this file.
 *
 * Rate limit: max 2 nudges per appointment, enforced SERVER-SIDE inside a
 * transaction under a per-appointment advisory lock (two concurrent sends
 * serialize, so the count-then-insert can't be raced past the cap). The rows
 * live in the shared Nudge ledger as kind "checkin_nudge" / channel WEB_PUSH -
 * push rows never count against any SMS cap or quota (every cap query filters
 * channel='SMS').
 *
 * The row is written PENDING inside the tx; the push goes out AFTER commit and
 * resolves it to SENT / FAILED via sendPushToClient's auditNudgeId param.
 */

export const APPOINTMENT_NUDGE_LIMIT = 2;
export const APPOINTMENT_NUDGE_KIND = "checkin_nudge";
export const APPOINTMENT_NUDGE_REPLY_KIND = "checkin_nudge_reply";

export class NudgeLimitError extends Error {
  constructor() {
    super("nudge_limit");
    this.name = "NudgeLimitError";
  }
}

export interface AppointmentNudgeResult {
  /** False when the appointment isn't an upcoming BOOKED row with a client. */
  ok: boolean;
  /** True when at least one of the client's devices accepted the push. */
  delivered: boolean;
}

export async function sendAppointmentNudge(params: {
  shopId: string;
  appointmentId: string;
  body: string;
  now?: Date;
}): Promise<AppointmentNudgeResult> {
  const now = params.now ?? new Date();

  const appt = await forShop(params.shopId).appointment.findFirst({
    where: {
      id: params.appointmentId,
      shopId: params.shopId,
      status: "BOOKED",
      startsAt: { gt: now },
      clientId: { not: null },
    },
    select: {
      id: true,
      clientId: true,
      manageToken: true,
    },
  });
  if (!appt || !appt.clientId) return { ok: false, delivered: false };
  const clientId = appt.clientId;

  // Count + insert under a per-appointment advisory lock so two concurrent
  // nudges can't both pass a count of 1. The lock key is namespaced apart from
  // the booking guard's ('appt:') so nudging never contends with booking.
  const nudgeId = await runWithShop(params.shopId, async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`nudge:${params.appointmentId}`}))`,
    );
    // FAILED rows (no reachable device) don't count: two attempts into the
    // void must not lock the barber out once the client re-enables push. The
    // anti-spam property holds - only deliverable sends (SENT, plus in-flight
    // PENDING) consume the cap.
    const sentSoFar = await tx.nudge.count({
      where: {
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        kind: APPOINTMENT_NUDGE_KIND,
        status: { in: ["PENDING", "SENT"] },
      },
    });
    if (sentSoFar >= APPOINTMENT_NUDGE_LIMIT) throw new NudgeLimitError();

    const row = await tx.nudge.create({
      data: {
        shopId: params.shopId,
        clientId,
        appointmentId: params.appointmentId,
        channel: "WEB_PUSH",
        kind: APPOINTMENT_NUDGE_KIND,
        status: "PENDING",
        body: params.body,
      },
      select: { id: true },
    });
    return row.id;
  });

  // Shop name for the push title (owner read - Shop is default-deny in-tenant).
  const shop = await prisma.shop.findUnique({
    where: { id: params.shopId },
    select: { name: true },
  });

  const res = await sendPushToClient({
    shopId: params.shopId,
    clientId,
    auditNudgeId: nudgeId,
    payload: {
      title: shop?.name ?? "Your barber",
      body: params.body,
      // Deep-link to the manage page, where the one-tap replies live.
      url: `${apiEnv().APP_BASE_URL}/book/manage/${appt.manageToken}`,
      tag: `nudge-${params.appointmentId}`,
    },
  });
  if (!res.anyDelivered) {
    logger.info(
      { shopId: params.shopId, appointmentId: params.appointmentId },
      "appointment nudge had no reachable device",
    );
  }
  return { ok: true, delivered: res.anyDelivered };
}
