import { prisma, runWithShop, type Prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { pokeAppointmentPass } from "../wallet/appointmentPass.js";
import {
  clawBackVisitEarn,
  earnPunchForVisitInTx,
  type EarnResult,
} from "../services/punch.js";
import { recomputeCadence } from "./cadence.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { refundForCancellation } from "../billing/payments.js";
import { notifySlotOpened } from "./slotOpened.js";
import { enqueueCancellationEmail } from "../services/appointmentCanceledNotify.js";
import { releaseForAppointment } from "./acuityMirror.js";
import { completeWalkInEntryForAppointmentInTx } from "./walkInComplete.js";

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
  // A walk-in queue entry riding this appointment goes terminal in the SAME
  // commit as the completion - and BEFORE the clientId guard, because the
  // entry's lifecycle doesn't depend on whether there is loyalty to earn.
  // CAS-idempotent inside (IN_SERVICE only), a no-op for every non-walk-in
  // appointment.
  await completeWalkInEntryForAppointmentInTx(tx, shop.id, appt.id, now);

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
  // suppressSlotOpened: skip the per-occurrence "a slot opened" barber+waitlist
  // notify. Used by cancelSeries so canceling a 26-week series doesn't fire 26
  // barber pushes; the series path sends ONE coalesced alert instead.
  opts: { applyPolicyFee?: boolean; suppressSlotOpened?: boolean } = {},
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

    // 🔴 THE TRANSITION IS A COMPARE-AND-SET, and the revision it bumps is
    // what identifies this cancellation.
    //
    // An unconditional update made "cancel" idempotent in appearance only:
    // two concurrent requests both succeeded, and because the outbox key was
    // built from each request's own clock they produced two different
    // "unique" keys - two intents, two emails. Real requests do not share a
    // millisecond; the old test only passed because it handed every racer the
    // same fixed timestamp.
    //
    // Now exactly one caller can move a BOOKED appointment to CANCELED. The
    // loser matches zero rows and does nothing at all, and the winner's
    // revision - a persisted counter, not a wall clock - becomes the identity
    // the email intent is bound to.
    const transitioned = await tx.appointment.updateMany({
      where: { id: appt.id, shopId, status: { not: outcome } },
      data: {
        status: outcome,
        canceledAt: outcome === "CANCELED" ? now : undefined,
        ...(outcome === "CANCELED"
          ? { cancellationRevision: { increment: 1 } }
          : {}),
      },
    });
    // Already in this state: an idempotent no-op. No second intent, no second
    // refund, no second teardown.
    if (transitioned.count === 0) return null;

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

    // 🔴 THE PROMISE TO EMAIL COMMITS WITH THE CANCELLATION, in this same
    // transaction. If the process dies one instruction later, the durable
    // record of "this customer must be told" is already on disk and the
    // outbox worker will keep it; if the transaction rolls back, so does the
    // promise, and nobody is told about a cancellation that never happened.
    //
    // Resend is NEVER called from in here - only a row is written.
    if (outcome === "CANCELED") {
      // Read back the revision this transition actually won, and key the
      // intent on it. Two racers cannot both get here, and the surviving
      // intent names a state change rather than a request.
      const current = await tx.appointment.findFirst({
        where: { id: appt.id, shopId },
        select: { cancellationRevision: true },
      });
      await enqueueCancellationEmail(tx, {
        shopId,
        appointmentId: appt.id,
        cancellationRevision: current?.cancellationRevision ?? 1,
      });
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
  if (outcome === "CANCELED" && !opts.suppressSlotOpened) {
    void notifySlotOpened({ shopId, appointmentId, now });
  }

  // Release the Acuity block this appointment was holding. ChairBack is
  // updated first (above) and Acuity second: the chair is already free here,
  // and a delete that fails leaves a RELEASING row the reconciler retries -
  // whereas deleting first and failing to cancel would free the time in Acuity
  // for a booking that still stands. Fire-and-forget for the same reason every
  // notify above is: a cancel must never fail because Acuity is unreachable.
  //
  // Runs for NO_SHOW too. A no-show inside its own span still frees the chair,
  // and a block left behind would keep the barber's Acuity calendar dark for
  // time he could still sell.
  void releaseForAppointment(shopId, appointmentId).catch(() => {
    // releaseForAppointment logs its own transitions; swallowing here keeps a
    // background rejection from taking the process down.
  });

  // Grey out the Apple Wallet appointment pass on every device that added it
  // (the pass re-fetches as VOIDED). Post-commit and fire-and-forget like every
  // notify above: a wallet problem must never affect the cancel, and the poke
  // never throws by contract. Runs for NO_SHOW too - that pass is equally dead.
  void pokeAppointmentPass(appointmentId);
  return true;
}

export type CancelSeriesScope = "this" | "future" | "all";

export interface CancelSeriesResult {
  canceled: number;
  seriesStatus: "CANCELED" | "ENDED";
}

/**
 * Cancel a recurring series by scope:
 *  - "this"   → just the one occurrence (fromAppointmentId).
 *  - "future" → that occurrence and every later still-BOOKED one.
 *  - "all"    → every still-BOOKED occurrence in the series.
 *
 * Loops the existing cancelAppointment per row (so each gets its own refund +
 * clawback), but SUPPRESSES the per-occurrence slot-opened alert and fires ONE
 * coalesced barber notification for the whole batch instead. Already-COMPLETED
 * occurrences are left untouched (their loyalty stands). Sets the series status.
 */
export async function cancelSeries(
  shopId: string,
  seriesId: string,
  scope: CancelSeriesScope,
  fromAppointmentId?: string,
  now = new Date(),
  opts: { applyPolicyFee?: boolean } = {},
): Promise<CancelSeriesResult | null> {
  // Resolve the anchor occurrence's start when scope needs it.
  let fromStartsAt: Date | null = null;
  if (scope === "this" || scope === "future") {
    if (!fromAppointmentId) return null;
    const anchor = await runWithShop(shopId, (tx) =>
      tx.appointment.findFirst({
        where: { id: fromAppointmentId, shopId, seriesId },
        select: { startsAt: true },
      }),
    );
    if (!anchor) return null;
    fromStartsAt = anchor.startsAt;
  }

  // Which still-BOOKED occurrences to cancel.
  const rows = await runWithShop(shopId, (tx) =>
    tx.appointment.findMany({
      where: {
        shopId,
        seriesId,
        status: "BOOKED",
        ...(scope === "this" ? { id: fromAppointmentId } : {}),
        ...(scope === "future" && fromStartsAt
          ? { startsAt: { gte: fromStartsAt } }
          : {}),
      },
      select: { id: true },
      orderBy: { startsAt: "asc" },
    }),
  );

  // A single-occurrence cancel keeps the normal per-slot alert (one freed slot,
  // one nudge). A future/all cancel suppresses per-occurrence alerts and, since
  // it frees a burst of capacity, relies on the standing waitlist rather than
  // firing N barber pushes - the barber initiated the cancel, so they know.
  const suppress = scope !== "this";
  let canceled = 0;
  for (const r of rows) {
    const ok = await cancelAppointment(shopId, r.id, "CANCELED", now, {
      suppressSlotOpened: suppress,
      // Customer-initiated (the manage page): the shop's cancellation policy
      // applies per occurrence, exactly as it would one visit at a time. The
      // barber's own series cancel never charges their client.
      applyPolicyFee: opts.applyPolicyFee === true,
    });
    if (ok) canceled++;
  }

  // Series status: a whole-series or all-future kill ends it; a single-occurrence
  // cancel leaves the series ACTIVE (later occurrences still stand).
  if (scope !== "this") {
    await runWithShop(shopId, (tx) =>
      tx.recurringSeries.updateMany({
        where: { id: seriesId, shopId },
        data: { status: "CANCELED" },
      }),
    ).catch(() => {});
  }

  return { canceled, seriesStatus: scope === "this" ? "ENDED" : "CANCELED" };
}
