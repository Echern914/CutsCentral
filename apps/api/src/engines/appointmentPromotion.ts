import { prisma, runWithShop, type Prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  clawBackVisitEarn,
  earnPunchForVisitInTx,
  type EarnResult,
} from "../services/punch.js";
import { recomputeCadence } from "./cadence.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { refundForCancellation } from "../billing/payments.js";
import { notifySlotOpened } from "./slotOpened.js";

/**
 * Turn a fulfilled native Appointment into a COMPLETED Visit that earns loyalty
 * through the EXISTING pipeline - the same earn+cadence+notify path Acuity and
 * manual visits use. There is NO second loyalty ledger.
 *
 * The promoted Visit reuses the (shopId, acuityAppointmentId) idempotency key
 * with a namespaced id "booking:{appointmentId}" (the same trick manual visits
 * use with "manual:{random}"), so re-running this job can never double-earn.
 */

/** Slice of Shop needed to earn (punchesPerVisit drives the base rate). */
interface PromoteShop {
  id: string;
  punchesPerVisit: number;
}

interface PromoteAppt {
  id: string;
  clientId: string | null;
  startsAt: Date;
  endsAt: Date;
  priceAtBooking: Prisma.Decimal | null;
  serviceName: string | null;
}

/**
 * Promote ONE appointment inside an already-open shop transaction. Shared by the
 * scheduled scan and the dashboard "mark done" action so the two can never
 * drift. Returns the earn result (null if the visit had already earned), so the
 * caller can fire the "you earned a punch" text exactly once. Does NOT recompute
 * cadence (caller does it after commit, like ingest/promotion).
 */
export async function promoteOneAppointmentInTx(
  tx: Prisma.TransactionClient,
  shop: PromoteShop,
  appt: PromoteAppt,
  now: Date,
): Promise<EarnResult> {
  if (!appt.clientId) return null; // no client to credit (defensive)

  // Lock the client row like every other ledger write (serializes earns).
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${appt.clientId} FOR UPDATE`;

  // Idempotent COMPLETED Visit keyed by the namespaced booking id.
  const acuityAppointmentId = `booking:${appt.id}`;
  const visit = await tx.visit.upsert({
    where: {
      shopId_acuityAppointmentId: {
        shopId: shop.id,
        acuityAppointmentId,
      },
    },
    create: {
      shopId: shop.id,
      clientId: appt.clientId,
      acuityAppointmentId,
      status: "COMPLETED",
      scheduledAt: appt.startsAt,
      endAt: appt.endsAt,
      completedAt: now,
      price: appt.priceAtBooking ?? undefined,
      serviceName: appt.serviceName,
    },
    update: {}, // already promoted - leave the existing visit untouched
  });

  // Earn punches (idempotent via PunchLedger.visitId). The visit "happened" when
  // it ended, so promo windows are checked against endsAt.
  const earn = await earnPunchForVisitInTx(
    tx,
    shop,
    appt.clientId,
    visit.id,
    appt.serviceName,
    appt.endsAt,
  );

  await tx.appointment.update({
    where: { id: appt.id },
    data: { status: "COMPLETED", completedAt: now, visitId: visit.id },
  });

  return earn;
}

/**
 * Scan for BOOKED appointments whose end time has passed and promote each into a
 * COMPLETED Visit + punch. Runs across all shops; idempotent (promoted rows flip
 * out of the BOOKED filter, and the visit/earn upserts are keyed). Mirrors
 * promoteCompletedVisits, but scans Appointment instead of Visit - the two jobs
 * stay independent so the native and Acuity paths never interfere.
 */
export async function promoteFulfilledAppointments(
  now = new Date(),
): Promise<number> {
  const due = await prisma.appointment.findMany({
    where: { status: "BOOKED", endsAt: { lt: now }, canceledAt: null },
    select: {
      id: true,
      shopId: true,
      clientId: true,
      startsAt: true,
      endsAt: true,
      priceAtBooking: true,
      service: { select: { name: true } },
    },
  });
  if (due.length === 0) return 0;

  const shops = await prisma.shop.findMany({
    where: { id: { in: [...new Set(due.map((a) => a.shopId))] } },
    select: { id: true, punchesPerVisit: true },
  });
  const shopById = new Map(shops.map((s) => [s.id, s]));

  let promoted = 0;
  for (const a of due) {
    const shop = shopById.get(a.shopId);
    if (!shop || !a.clientId) continue;
    try {
      const earn = await runWithShop(a.shopId, (tx) =>
        promoteOneAppointmentInTx(
          tx,
          shop,
          {
            id: a.id,
            clientId: a.clientId,
            startsAt: a.startsAt,
            endsAt: a.endsAt,
            priceAtBooking: a.priceAtBooking,
            serviceName: a.service?.name ?? null,
          },
          now,
        ),
      );
      await recomputeCadence(a.shopId, a.clientId);
      if (earn) {
        await notifyPunchEarned({
          shopId: a.shopId,
          clientId: a.clientId,
          earned: earn.earned,
          balance: earn.balance,
          cardTypeId: earn.cardTypeId,
          cardName: earn.cardName,
          now,
        });
      }
      promoted++;
    } catch (err) {
      logger.error({ err, appointmentId: a.id }, "appointment promotion failed");
    }
  }

  logger.info({ promoted }, "promoted fulfilled appointments");
  return promoted;
}

/**
 * Cancel or no-show an appointment. If it was already promoted to a Visit, the
 * Visit is set terminal and its phantom punch clawed back (the same
 * clawBackVisitEarn ingest uses for a retroactive Acuity cancel), then cadence
 * is recomputed. A cancel BEFORE promotion just flips the status (the partial
 * unique then frees the slot). Returns false if the appointment isn't found.
 */
export async function cancelAppointment(
  shopId: string,
  appointmentId: string,
  outcome: "CANCELED" | "NO_SHOW",
  now = new Date(),
  // applyPolicyFee: a CUSTOMER cancel honors the shop's cancellation policy (a
  // fee may be kept if inside the window). A BARBER cancel (default) refunds in
  // full - the customer shouldn't be penalized for the shop canceling. NO_SHOW
  // never auto-refunds here (an already-captured ahead payment stays; the barber
  // can refund by hand, and uncaptured-hold release is a Phase-3 concern).
  opts: { applyPolicyFee?: boolean } = {},
): Promise<boolean> {
  const result = await runWithShop(shopId, async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: {
        id: true,
        clientId: true,
        visitId: true,
        status: true,
        startsAt: true,
        payment: { select: { id: true } },
      },
    });
    if (!appt) return null;

    await tx.appointment.update({
      where: { id: appt.id },
      data: {
        status: outcome,
        canceledAt: outcome === "CANCELED" ? now : undefined,
      },
    });

    // Already promoted: tear down the Visit's loyalty footprint.
    if (appt.visitId) {
      if (appt.clientId) {
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${appt.clientId} FOR UPDATE`;
      }
      await tx.visit.update({
        where: { id: appt.visitId },
        data: {
          status: outcome,
          completedAt: null,
          canceledAt: outcome === "CANCELED" ? now : null,
          noShow: outcome === "NO_SHOW",
        },
      });
      await clawBackVisitEarn(tx, shopId, appt.visitId);
    }
    return {
      clientId: appt.clientId,
      hadVisit: Boolean(appt.visitId),
      paymentId: appt.payment?.id ?? null,
      startsAt: appt.startsAt,
    };
  });

  if (!result) return false;
  // The completed-visit set changed: recompute cadence (outside the tx).
  if (result.hadVisit && result.clientId) {
    await recomputeCadence(shopId, result.clientId);
  }

  // Refund a paid booking on cancellation, AFTER the tx (Stripe network call).
  // Only on CANCELED (not NO_SHOW) and only when there's a payment row.
  if (outcome === "CANCELED" && result.paymentId) {
    let feeCents = 0;
    if (opts.applyPolicyFee) {
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { cancelWindowHours: true, cancelFeeBps: true },
      });
      if (shop && shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0) {
        const windowMs = shop.cancelWindowHours * 60 * 60 * 1000;
        const insideWindow = result.startsAt.getTime() - now.getTime() < windowMs;
        if (insideWindow) {
          const payment = await prisma.payment.findUnique({
            where: { id: result.paymentId },
            select: { amount: true, capturedAmount: true },
          });
          const collected = payment?.capturedAmount ?? payment?.amount ?? 0;
          feeCents = Math.floor((collected * shop.cancelFeeBps) / 10000);
        }
      }
    }
    await refundForCancellation({ paymentId: result.paymentId, feeCents });
  }

  // A CANCELED future slot frees up: alert the barber + nudge matching
  // waitlisters (both audiences from one pass, all gated inside). Fire-and-
  // forget - a notify issue must never affect the cancel. NO_SHOW never fires
  // (that slot's time has already passed). Covers BOTH the barber-dashboard
  // cancel and the customer manage-page cancel, since both route through here.
  if (outcome === "CANCELED") {
    void notifySlotOpened({ shopId, appointmentId, now });
  }
  return true;
}
