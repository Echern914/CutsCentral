import { releaseCardOnFile } from "../billing/cardOnFile.js";
import { settleCardOnFile } from "../services/cardOnFileSettle.js";
import { clientCancelKeptCents } from "@chairback/config";
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
import { autoFillShouldQueue, queueAutoFillRun } from "./autoFill.js";
import { trackBackgroundWork } from "../backgroundWork.js";
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
  /**
   * `byShop`: someone at the shop finished this visit (Done, checkout, walk-in
   * Complete) - false when the 15-minute sweep completed it on its own,
   * which an unmarked no-show also does. Recorded as completedByShop; the tip
   * ask goes only to visits the shop finished.
   */
  opts: { byShop?: boolean } = {},
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
    data: {
      status: "COMPLETED",
      completedAt: now,
      visitId: visit.id,
      ...(opts.byShop ? { completedByShop: true } : {}),
    },
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
      // The visit happened: nothing left to protect. Let the kept card go.
      void releaseCardOnFile({ shopId: a.shopId, appointmentId: a.id, reason: "completed" });
      // Devices holding this booking's Wallet pass re-fetch it as COMPLETED.
      // Post-commit and fire-and-forget; the poke never throws by contract.
      void pokeAppointmentPass(a.id);
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
  // never auto-refunds here (an already-captured ahead payment stays; the shop
  // can give it back with Refund deposit - billing/depositRefund.ts - and
  // uncaptured-hold release is a Phase-3 concern).
  // suppressSlotOpened: skip the per-occurrence "a slot opened" barber+waitlist
  // notify. Used by cancelSeries so canceling a 26-week series doesn't fire 26
  // barber pushes; the series path sends ONE coalesced alert instead.
  // initiator: who cancelled. Only a CLIENT's own cancellation starts
  // Auto-fill (engines/autoFill.ts): a barber clearing a sick afternoon must
  // not have their best clients booked into time they will not be there. Default
  // "barber", so only the call sites that know better say otherwise.
  //
  // The last four exist for REMOVING a walk-in recorded by mistake (POST
  // /appointments/:id/remove-walk-in) - a correction, not a cancellation, so
  // it keeps this teardown (status, loyalty clawback, Acuity release, out of
  // revenue) and drops everything that speaks or pays:
  // onlyFrom: the CAS moves the row only out of these statuses; anything else
  //   is the same idempotent no-op (false) as an already-cancelled row.
  // silent: tell NOBODY - no cancellation email, no slot-opened alert, no
  //   Auto-fill run, no Wallet pass poke.
  // dismiss: clear it off the day view in the same write.
  // refuseIfMoney: move no money. A live Payment row of ANY purpose (a booking
  //   payment, a Tap to Pay or card checkout, a tip) or a kept card throws
  //   CancelRefusedError inside the transaction, so nothing changes; and the
  //   refund / card-on-file steps below never run.
  opts: {
    applyPolicyFee?: boolean;
    suppressSlotOpened?: boolean;
    initiator?: "customer" | "barber";
    onlyFrom?: Array<"PENDING" | "BOOKED" | "COMPLETED" | "NO_SHOW">;
    silent?: boolean;
    dismiss?: boolean;
    refuseIfMoney?: boolean;
  } = {},
): Promise<boolean> {
  // Shop is owner-only, so this is read before the tenant transaction; the
  // run itself is written inside it, behind the CAS.
  const autoFill =
    outcome === "CANCELED" &&
    !opts.silent &&
    opts.initiator === "customer" &&
    (await autoFillShouldQueue(shopId, now).catch((err: unknown) => {
      // Never the reason a cancellation fails: it just goes the ordinary way.
      logger.error({ err, shopId, appointmentId }, "cancel: auto-fill check failed");
      return false;
    }));
  const result = await runWithShop(shopId, async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: {
        id: true,
        clientId: true,
        visitId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        staffId: true,
        serviceId: true,
        priceAtBooking: true,
        service: { select: { name: true } },
        // The BOOKING payment: the one promotion may capture or refund. A
        // balance collected at checkout is money already settled for a cut that
        // happened, and must never be swept up by this path.
        payments: { where: { purpose: "booking" }, select: { id: true } },
        // Card on file: what to charge or let go of AFTER the tx (Stripe call).
        cardOnFile: { select: { id: true, status: true } },
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
      where: {
        id: appt.id,
        shopId,
        status: opts.onlyFrom ? { in: opts.onlyFrom } : { not: outcome },
      },
      data: {
        status: outcome,
        canceledAt: outcome === "CANCELED" ? now : undefined,
        ...(outcome === "CANCELED"
          ? { cancellationRevision: { increment: 1 } }
          : {}),
        ...(opts.dismiss ? { dismissedAt: now } : {}),
      },
    });
    // Already in this state: an idempotent no-op. No second intent, no second
    // refund, no second teardown.
    if (transitioned.count === 0) return null;

    // 🔴 MOVE NO MONEY. Read AFTER the CAS, while its row lock is held, and
    // thrown so the whole transition rolls back: a refusal leaves the row
    // exactly as it was. Any Payment that is not dead is money (or a form a
    // client could still pay) that only the shop's own refund should touch.
    if (opts.refuseIfMoney) {
      const live = await tx.payment.findFirst({
        where: { appointmentId: appt.id, shopId, status: { notIn: ["canceled", "failed"] } },
        select: { id: true },
      });
      const keptCard =
        appt.cardOnFile !== null && ["saved", "pending"].includes(appt.cardOnFile.status);
      if (live || keptCard) throw new CancelRefusedError("money_taken");
    }

    // 🔴 A CANCELLED SPECIAL GOES BACK ON SALE. A targeted slot is capacity-1
    // (bookedAppointmentId is unique), and nothing else ever cleared it: a
    // special booked and then cancelled - by the barber, the customer's own
    // manage link, the receptionist or a series cancel, all of which land
    // here - stayed "sold" to a booking that no longer existed, and never
    // appeared on the website again. (Declining a request and a failed Acuity
    // mirror already released it; a real cancel was the gap, recorded only as
    // "a booked cancel still keeps it consumed" with no reason given.)
    //
    // In THIS transaction, behind the CAS above, so it happens exactly once
    // and only when the cancel really did. A NO-SHOW keeps it: the time was
    // held and has passed. Undoing the cancel re-claims it if it is still free
    // - see POST /appointments/:id/restore.
    if (outcome === "CANCELED") {
      await tx.targetedSlot.updateMany({
        where: { shopId, bookedAppointmentId: appt.id },
        data: { bookedAppointmentId: null },
      });
    }

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
    // A silent cancel promises nobody anything, so it writes no row at all.
    if (outcome === "CANCELED" && !opts.silent) {
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
      // 🔴 AUTO-FILL'S RUN COMMITS WITH THE CANCELLATION, keyed on the same
      // revision: it exists exactly when this cancellation does, once, and a
      // restart one instruction later cannot lose it.
      if (autoFill) {
        await queueAutoFillRun(tx, {
          shopId,
          appointment: appt,
          cancellationRevision: current?.cancellationRevision ?? 1,
          now,
        });
      }
    }

    return {
      clientId: appt.clientId,
      hadVisit: Boolean(appt.visitId),
      paymentId: appt.payments[0]?.id ?? null,
      startsAt: appt.startsAt,
      priceAtBooking: appt.priceAtBooking,
      serviceName: appt.service?.name ?? null,
      cardOnFile: appt.cardOnFile,
    };
  });

  if (!result) return false;
  // The completed-visit set changed: recompute cadence (outside the tx).
  if (result.hadVisit && result.clientId) {
    await recomputeCadence(shopId, result.clientId);
  }

  // Refund a paid booking on cancellation, AFTER the tx (Stripe network call).
  // Only on CANCELED (not NO_SHOW) and only when there's a payment row - and
  // never on a cancel that promised to move no money.
  if (outcome === "CANCELED" && result.paymentId && !opts.refuseIfMoney) {
    let feeCents = 0;
    if (opts.applyPolicyFee) {
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { cancelWindowHours: true, cancelFeeBps: true },
      });
      const payment = await prisma.payment.findUnique({
        where: { id: result.paymentId },
        select: { amount: true, capturedAmount: true, nonRefundable: true },
      });
      // 🔴 The SHARED rule (config/shopPolicy.ts), so what the receptionist
      // tells a client a cancellation costs is computed by the same rule this
      // line charges with. It used to be inline here, where nothing that speaks
      // to customers could see it.
      //
      // 🔴 THE NON-REFUNDABLE TERMS ARE THIS BOOKING'S OWN (the snapshot on its
      // payment), never the shop's switch today - and they are NOT behind the
      // "window and fee both set" test the fee alone used to sit behind: a
      // non-refundable deposit is kept at a shop with no window configured.
      feeCents = clientCancelKeptCents({
        collectedCents: payment?.capturedAmount ?? payment?.amount ?? 0,
        nonRefundable: payment?.nonRefundable === true,
        cancelWindowHours: shop?.cancelWindowHours ?? 0,
        cancelFeeBps: shop?.cancelFeeBps ?? 0,
        startsAt: result.startsAt,
        now,
      });
    }
    await refundForCancellation({ paymentId: result.paymentId, feeCents });
  }

  // CARD ON FILE. Nothing was collected, so there is nothing to refund - but
  // there may be something to CHARGE, or a card to let go of. The rule lives in
  // services/cardOnFileSettle.ts: charged only when the shop switched fees on
  // AND it is on the customer (a no-show, or their own cancel inside the
  // window); everything else releases the card. Awaited like the refund above
  // and never throws - the mark itself already stands.
  if (opts.refuseIfMoney) {
    // Refused above if a card was kept; nothing to settle or release.
  } else if (result.cardOnFile && result.cardOnFile.status === "saved") {
    await settleCardOnFile({
      shopId,
      appointmentId,
      outcome,
      applyPolicyFee: Boolean(opts.applyPolicyFee),
      priceAtBooking: result.priceAtBooking,
      serviceName: result.serviceName,
      startsAt: result.startsAt,
      now,
    });
  } else if (result.cardOnFile && result.cardOnFile.status === "pending") {
    // A booking made WITHOUT a card (the card step is optional) whose card
    // never arrived. Nothing to charge; let the unfinished card go, so a card
    // form still open on the client's phone cannot file a card on a booking
    // that no longer stands.
    // Never throws into the cancel, like the settlement above: the mark already
    // stands, and the Acuity release and alerts below must still run.
    await releaseCardOnFile({
      shopId,
      appointmentId,
      reason: outcome === "NO_SHOW" ? "no_show_no_card" : "canceled_no_card",
    }).catch((err: unknown) => {
      logger.warn({ err, shopId, appointmentId }, "cancel: could not let go of the unfinished card");
    });
  }

  // A CANCELED future slot frees up: alert the barber + nudge matching
  // waitlisters (both audiences from one pass, all gated inside). Fire-and-
  // forget - a notify issue must never affect the cancel. NO_SHOW never fires
  // (that slot's time has already passed). Covers BOTH the barber-dashboard
  // cancel and the customer manage-page cancel, since both route through here.
  if (outcome === "CANCELED" && !opts.suppressSlotOpened && !opts.silent) {
    // Tracked (backgroundWork.ts) so a test can know it has finished; inert
    // in production.
    void trackBackgroundWork(notifySlotOpened({ shopId, appointmentId, now }));
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
  // A silent cancel pokes nothing: a poke is a push to the client's device.
  if (!opts.silent) void pokeAppointmentPass(appointmentId);
  return true;
}

/**
 * A cancel that refused to happen, rolled back with nothing changed. Thrown
 * only for callers that asked for the refusal (`refuseIfMoney`).
 */
export class CancelRefusedError extends Error {
  constructor(readonly reason: "money_taken") {
    super(`cancel refused: ${reason}`);
    this.name = "CancelRefusedError";
  }
}

export type CancelSeriesScope = "this" | "future" | "all";

export interface CancelGroupResult {
  /** How many members were still BOOKED and are now cancelled. */
  canceled: number;
}

/**
 * Cancel EVERY remaining member of a back-to-back group.
 *
 * 🔴 EXPLICIT ONLY. Nothing calls this because one attendee dropped out -
 * cancelling a member is an ordinary single-appointment cancel through that
 * member's own manage token, and it leaves the rest of the party booked,
 * because they are still coming. The group is only ended when someone asks for
 * the whole visit to be called off.
 *
 * Shaped exactly like cancelSeries, and for the same reasons: it loops
 * cancelAppointment per member rather than doing its own UPDATE, so every
 * existing consequence of a cancellation - the refund rule, the cancellation
 * email outbox, the Acuity block release, the Wallet pass poke - happens once
 * per appointment and stays in one place. `suppressSlotOpened` is on because a
 * group cancel frees a burst of adjacent capacity, and firing three separate
 * "a slot opened" alerts for one party is noise the barber did not ask for.
 */
export async function cancelGroup(
  shopId: string,
  groupId: string,
  now = new Date(),
  opts: { applyPolicyFee?: boolean } = {},
): Promise<CancelGroupResult | null> {
  const group = await runWithShop(shopId, (tx) =>
    tx.appointmentGroup.findFirst({
      where: { id: groupId, shopId },
      select: { id: true },
    }),
  );
  // 🔴 Tenant isolation: a group id from another shop reads as absent here, so
  // this returns null rather than cancelling someone else's customers.
  if (!group) return null;

  const rows = await runWithShop(shopId, (tx) =>
    tx.appointment.findMany({
      where: { shopId, groupId, status: "BOOKED" },
      select: { id: true },
      orderBy: { startsAt: "asc" },
    }),
  );

  let canceled = 0;
  for (const r of rows) {
    const ok = await cancelAppointment(shopId, r.id, "CANCELED", now, {
      suppressSlotOpened: true,
      applyPolicyFee: opts.applyPolicyFee === true,
    });
    if (ok) canceled++;
  }

  await runWithShop(shopId, (tx) =>
    tx.appointmentGroup.updateMany({
      where: { id: groupId, shopId, status: "ACTIVE" },
      data: { status: "CANCELED", canceledAt: now },
    }),
  ).catch(() => {});

  return { canceled };
}

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
