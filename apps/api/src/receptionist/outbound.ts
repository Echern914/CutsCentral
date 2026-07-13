import { forShop, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getMessageProvider } from "../messaging/twilio.js";

/**
 * The receptionist's one SMS exit. Every send is recorded on the Nudge ledger
 * (write-ahead PENDING -> SENT/FAILED, like every other send path) and re-checks
 * optedOut at SEND time - a STOP that lands mid-turn must win over an
 * already-composed reply.
 *
 * kinds:
 *  - "receptionist_reply": a reply in a consumer-initiated thread. Exempt from
 *    quiet hours and the daily cap (the client texted first) but NEVER exempt
 *    from optedOut.
 *  - "receptionist": proactive gap-fill outreach. The CALLER (gapfill.ts) owns
 *    the marketing gates (consent + quiet hours + cap + suppression); this
 *    function still enforces the optedOut floor.
 */
export async function sendReceptionistSms(params: {
  shopId: string;
  clientId: string;
  phone: string;
  body: string;
  kind: "receptionist" | "receptionist_reply";
}): Promise<boolean> {
  // Send-time STOP re-check (global by phone - STOP opts out every match).
  const optedOut = await prisma.client.findFirst({
    where: { phone: params.phone, optedOut: true },
    select: { id: true },
  });
  if (optedOut) {
    logger.info(
      { shopId: params.shopId, clientId: params.clientId },
      "receptionist send skipped: opted out",
    );
    return false;
  }

  const db = forShop(params.shopId);
  let nudgeId: string | undefined;
  try {
    const nudge = await db.nudge.create({
      data: {
        clientId: params.clientId,
        channel: "SMS",
        status: "PENDING",
        kind: params.kind,
        body: params.body,
      },
    });
    nudgeId = nudge.id;
    const result = await getMessageProvider().send({
      to: params.phone,
      body: params.body,
    });
    await db.nudge.update({
      where: { id: nudge.id },
      data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
    });
    return true;
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, clientId: params.clientId },
      "receptionist SMS send failed",
    );
    if (nudgeId) {
      await db.nudge
        .update({
          where: { id: nudgeId },
          data: { status: "FAILED", failedReason: (err as Error).message },
        })
        .catch(() => {});
    }
    return false;
  }
}
