import { apiEnv } from "@chairback/config";
import { formatTipCents } from "@chairback/config/tips";
import { runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { trackBackgroundWork } from "../backgroundWork.js";
import { stripeCollectedCents } from "../engines/appointmentPayment.js";
import { sendPushToUser } from "../messaging/push.js";
import { appointmentDeepLink, recipientForAppointment, resolveNotifyPrefs } from "./barberNotify.js";
import { TIP_RECEIPT_KIND, tipReceiptKey } from "./tipEmails.js";

/**
 * A TIP JUST PAID: the client's receipt and ONE push to the staff member.
 *
 * Called from billing/payments.ts applyIntentSnapshot on every succeeded
 * snapshot - the webhook, the page's refresh, resume, retire, the tip sweep
 * and the reconciler all land there - and from the self-heal in
 * engines/tipRequests.ts. Whichever gets there first claims the announcement
 * on Payment.tipAnnouncedAt; every other call is a no-op.
 *
 * The claim and the receipt's outbox row commit TOGETHER, so a crash between
 * them cannot leave a claimed tip with no receipt. The push goes after the
 * commit and is at most once: a lost push is a missed heads-up, a second one
 * is a tip announced twice.
 */
export async function announceTipPaid(
  key: { paymentId?: string; piId?: string },
  now: Date = new Date(),
  /**
   * When the tip went paid, if the caller knows better than "now". The live
   * paths call this the moment they see it succeed; the self-heal, minutes
   * later, passes the row's last write instead. Stamped as tipAnnouncedAt,
   * which the receipt prints as the paid time.
   */
  opts: { seenPaidAt?: Date } = {},
): Promise<boolean> {
  const where = key.paymentId
    ? { id: key.paymentId }
    : key.piId
      ? { stripePaymentIntentId: key.piId }
      : null;
  if (!where) return false;
  try {
    const row = await runAsOwner((tx) =>
      tx.payment.findFirst({
        where,
        select: {
          id: true,
          shopId: true,
          appointmentId: true,
          purpose: true,
          status: true,
          amount: true,
          capturedAmount: true,
          refundedAmount: true,
          tipAnnouncedAt: true,
        },
      }),
    );
    // Decided from amounts, not the status: a tip partly refunded before this
    // ran was still paid, and one refunded in full is nothing to announce.
    if (!row || row.purpose !== "tip" || row.tipAnnouncedAt || stripeCollectedCents(row) === 0) {
      return false;
    }
    const claimed = await runAsOwner(async (tx) => {
      const r = await tx.payment.updateMany({
        where: { id: row.id, purpose: "tip", tipAnnouncedAt: null },
        data: { tipAnnouncedAt: opts.seenPaidAt ?? now },
      });
      if (r.count === 0) return false;
      // Always queued, address or not: the deliverer records "no_address" in
      // the ledger, and the push below does not depend on it.
      await tx.emailIntent.createMany({
        data: [
          {
            kind: TIP_RECEIPT_KIND,
            idempotencyKey: tipReceiptKey(row.id),
            shopId: row.shopId,
            appointmentId: row.appointmentId,
            status: "PENDING",
            nextAttemptAt: new Date(0), // due immediately
          },
        ],
        skipDuplicates: true,
      });
      return true;
    });
    if (claimed) {
      void trackBackgroundWork(
        notifyStaffOfTip({
          shopId: row.shopId,
          appointmentId: row.appointmentId,
          cents: row.capturedAmount ?? row.amount,
        }),
      );
    }
    return claimed;
  } catch (err) {
    logger.error(
      { paymentId: key.paymentId ?? null, errName: err instanceof Error ? err.name : "unknown" },
      "tip announcement failed",
    );
    return false;
  }
}

/** The push copy. The staff member's own phone says "you"; the owner's names them. */
export function tipPushCopy(p: {
  firstName: string | null;
  amount: string;
  toStaffMember: boolean;
  staffName: string;
}): { title: string; body: string } {
  const who = p.firstName?.trim() || "A client";
  return {
    title: "New tip",
    body: p.toStaffMember
      ? `${who} left you a ${p.amount} tip.`
      : `${who} left ${p.staffName} a ${p.amount} tip.`,
  };
}

/**
 * ONE push to whoever worked the visit - the owner when that staff member has
 * no account - and nothing else: no text, no email (sendToBarber would email
 * them when texting is off). Their push switch is honoured. Never throws.
 */
export async function notifyStaffOfTip(p: {
  shopId: string;
  appointmentId: string;
  cents: number;
}): Promise<void> {
  try {
    const appt = await runAsOwner((tx) =>
      tx.appointment.findFirst({
        where: { id: p.appointmentId, shopId: p.shopId },
        select: {
          id: true,
          firstName: true,
          startsAt: true,
          staff: { select: { name: true, userId: true } },
          shop: { select: { ownerId: true, timezone: true } },
        },
      }),
    );
    if (!appt) return;
    const userId = recipientForAppointment(appt, appt.shop.ownerId);
    const prefs = await resolveNotifyPrefs(p.shopId, userId);
    if (!prefs.pushEnabled) return;
    // A BARBER seat cannot open the appointments manager, so its link is the
    // dashboard home; everyone else lands on the visit itself.
    const seat = await runAsOwner((tx) =>
      tx.shopMember.findUnique({
        where: { shopId_userId: { shopId: p.shopId, userId } },
        select: { role: true },
      }),
    );
    const url =
      seat?.role === "BARBER"
        ? `${apiEnv().APP_BASE_URL}/dashboard`
        : appointmentDeepLink(appt.id, { startsAt: appt.startsAt, timezone: appt.shop.timezone });
    const copy = tipPushCopy({
      firstName: appt.firstName,
      amount: formatTipCents(p.cents),
      toStaffMember: appt.staff.userId !== null,
      staffName: appt.staff.name,
    });
    await sendPushToUser({
      userId,
      shopId: p.shopId,
      payload: { ...copy, url, tag: `tip-${appt.id}` },
    });
  } catch (err) {
    logger.error(
      { appointmentId: p.appointmentId, errName: err instanceof Error ? err.name : "unknown" },
      "tip push failed",
    );
  }
}
