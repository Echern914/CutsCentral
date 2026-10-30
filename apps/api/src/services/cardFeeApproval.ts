import { CARD_FEE_APPROVAL_MS, type NoShowChargeResult } from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { releaseCardOnFile } from "../billing/cardOnFile.js";
import { chargeFeeAndTell, noShowChargeResult } from "./cardOnFileSettle.js";

/**
 * 🔴 THE BARBER APPROVES A CLIENT'S LATE-CANCEL FEE (Shop.cardFeeNeedsApproval
 * - Drick, 2026-10-30: he "wants to make sure that he approves of the charge").
 *
 * A client who cancels inside the cutoff from their link, or through the
 * texting receptionist, is not charged on the spot at such a shop: settle
 * (services/cardOnFileSettle.ts holdCardFeeForApproval) writes the fee onto the
 * appointment and keeps the card. From there exactly one of three things
 * happens, each a compare-and-set that clears the waiting fee, so only one can
 * ever win:
 *
 *   - Charge: the barber says yes. The card is charged the figure written at
 *     the cancel - never re-read from today's settings, never typed - through
 *     the same charge-and-tell an immediate fee uses.
 *   - Waive: the barber says no. The card is let go, uncharged.
 *   - Lapse: nobody decided within CARD_FEE_APPROVAL_DAYS. The card is let go,
 *     uncharged - a kept card is a promise about THIS booking, and it does not
 *     stay attached indefinitely waiting for a decision.
 */

export type CardFeeDecision = "charge" | "waive";

export type DecideCardFeeResult =
  | { ok: true; decision: "charged"; card: NoShowChargeResult | null }
  | { ok: true; decision: "waived" }
  | { ok: false; error: "nothing_waiting" | "lapsed" };

/** The waiting fee is cleared; `waived` also stamps cardFeeWaivedAt. */
async function claimWaitingFee(
  shopId: string,
  appointmentId: string,
  since: Date,
  waived: Date | null,
): Promise<boolean> {
  const claimed = await runWithShop(shopId, (tx) =>
    tx.appointment.updateMany({
      // Claimed by its own `since`, so a fee claimed and put back (a setup
      // problem, below) is the same fee, and nothing else can match.
      where: { id: appointmentId, shopId, cardFeeAwaitingSince: since },
      data: {
        cardFeeAwaitingCents: null,
        cardFeeAwaitingSince: null,
        ...(waived ? { cardFeeWaivedAt: waived } : {}),
      },
    }),
  );
  return claimed.count === 1;
}

export async function decideCardFee(params: {
  shopId: string;
  appointmentId: string;
  decision: CardFeeDecision;
  now?: Date;
}): Promise<DecideCardFeeResult> {
  const now = params.now ?? new Date();
  const appt = await runWithShop(params.shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: params.appointmentId, shopId: params.shopId },
      select: {
        cardFeeAwaitingCents: true,
        cardFeeAwaitingSince: true,
        startsAt: true,
        service: { select: { name: true } },
      },
    }),
  );
  if (!appt || appt.cardFeeAwaitingCents === null || appt.cardFeeAwaitingSince === null) {
    return { ok: false, error: "nothing_waiting" };
  }
  const since = appt.cardFeeAwaitingSince;

  // Past its time, a Charge is refused even if the sweep has not run yet: the
  // fee lapses exactly when the barber was told it would.
  if (now.getTime() - since.getTime() > CARD_FEE_APPROVAL_MS) {
    await lapseOne(params.shopId, params.appointmentId, since, now);
    return { ok: false, error: "lapsed" };
  }

  if (params.decision === "waive") {
    if (!(await claimWaitingFee(params.shopId, params.appointmentId, since, now))) {
      return { ok: false, error: "nothing_waiting" };
    }
    await releaseCardOnFile({ shopId: params.shopId, appointmentId: params.appointmentId, reason: "fee_waived" });
    logger.info({ shopId: params.shopId, appointmentId: params.appointmentId }, "card on file: barber waived the late-cancel fee");
    return { ok: true, decision: "waived" };
  }

  const shop = await prisma.shop.findUnique({
    where: { id: params.shopId },
    select: { name: true, timezone: true, ownerId: true },
  });
  if (!shop) return { ok: false, error: "nothing_waiting" };
  if (!(await claimWaitingFee(params.shopId, params.appointmentId, since, null))) {
    return { ok: false, error: "nothing_waiting" };
  }
  const cents = appt.cardFeeAwaitingCents;
  const result = await chargeFeeAndTell({
    shopId: params.shopId,
    appointmentId: params.appointmentId,
    shop,
    cents,
    reason: "late_cancel",
    serviceName: appt.service?.name ?? null,
    startsAt: appt.startsAt,
  });
  // Stripe refused the REQUEST, not the card: the card is back to `saved`, and
  // the decision the barber made is not used up by our problem. The fee waits
  // again, on its original clock, so they can try again.
  if (result.action === "setup_problem") {
    await runWithShop(params.shopId, (tx) =>
      tx.appointment.updateMany({
        where: {
          id: params.appointmentId,
          shopId: params.shopId,
          cardFeeAwaitingSince: null,
          cardFeeWaivedAt: null,
        },
        data: { cardFeeAwaitingCents: cents, cardFeeAwaitingSince: since },
      }),
    );
  }
  logger.info(
    { shopId: params.shopId, appointmentId: params.appointmentId, action: result.action },
    "card on file: barber approved the late-cancel fee",
  );
  return { ok: true, decision: "charged", card: noShowChargeResult(result) };
}

async function lapseOne(shopId: string, appointmentId: string, since: Date, now: Date): Promise<boolean> {
  if (!(await claimWaitingFee(shopId, appointmentId, since, now))) return false;
  await releaseCardOnFile({ shopId, appointmentId, reason: "fee_approval_lapsed" });
  logger.info({ shopId, appointmentId }, "card on file: late-cancel fee lapsed undecided - card let go");
  return true;
}

/**
 * Let go of every card whose fee waited past CARD_FEE_APPROVAL_DAYS with no
 * decision. Rides the hold sweep's schedule and lease (scheduler.ts).
 */
export async function sweepLapsedCardFees(now: Date = new Date()): Promise<number> {
  const due = await prisma.appointment.findMany({
    where: { cardFeeAwaitingSince: { lt: new Date(now.getTime() - CARD_FEE_APPROVAL_MS) } },
    select: { id: true, shopId: true, cardFeeAwaitingSince: true },
    take: 200,
  });
  let lapsed = 0;
  for (const row of due) {
    try {
      if (await lapseOne(row.shopId, row.id, row.cardFeeAwaitingSince!, now)) lapsed++;
    } catch (err) {
      // One bad row must not stop the sweep; the next tick retries it.
      logger.error({ err, shopId: row.shopId, appointmentId: row.id }, "card fee lapse failed for one appointment");
    }
  }
  if (lapsed > 0) logger.info({ count: lapsed }, "lapsed late-cancel fees let go");
  return lapsed;
}
